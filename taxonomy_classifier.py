#!/usr/bin/env python3
"""BioCLIP multi-view taxonomy inference using the deployed hierarchical model."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image


SCRIPT_DIR = Path(__file__).resolve().parent
BIOCLIP_MODEL = "hf-hub:imageomics/bioclip-2"
CHECKPOINT_PATH = SCRIPT_DIR / "Data" / "taxonomy_classifier.pt"


class HierarchicalClassifier(nn.Module):
    def __init__(
        self,
        embedding_dim: int,
        hidden_dim: int,
        num_species: int,
        num_orders: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(embedding_dim, hidden_dim),
            nn.ReLU(),
        )
        self.dropout = nn.Dropout(dropout)
        self.species_head = nn.Linear(hidden_dim, num_species)
        self.order_head = nn.Linear(hidden_dim, num_orders)

    def forward(self, embeddings: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        hidden = self.dropout(self.shared(embeddings))
        return self.species_head(hidden), self.order_head(hidden)


def select_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def normalize_probabilities(probabilities: torch.Tensor) -> torch.Tensor:
    total = probabilities.sum(dim=-1, keepdim=True).clamp_min(1e-12)
    return probabilities / total


def top_predictions(
    probabilities: torch.Tensor,
    names: list[str],
    k: int = 3,
) -> list[dict[str, Any]]:
    probabilities = probabilities.detach().float().cpu().reshape(-1)
    k = min(k, len(names))
    scores, indices = torch.topk(probabilities, k=k)
    return [
        {"name": names[int(index)], "confidence": float(score)}
        for score, index in zip(scores.tolist(), indices.tolist())
    ]


class TaxonomyClassifier:
    """Run the deployed iNaturalist-trained hierarchical BioCLIP classifier."""

    def __init__(self) -> None:
        self.model_name = BIOCLIP_MODEL
        self.device = select_device()
        self.checkpoint_path = CHECKPOINT_PATH

        if not self.checkpoint_path.exists():
            raise FileNotFoundError(
                f"Taxonomy checkpoint not found: {self.checkpoint_path}\n"
                "Copy taxonomy_classifier.pt into the BugPicker Data directory."
            )

        checkpoint: dict[str, Any] = torch.load(
            self.checkpoint_path,
            map_location="cpu",
            weights_only=False,
        )

        self.species_names = list(checkpoint["species_names"])
        self.order_names = list(checkpoint["all_orders"])

        embedding_dim = int(checkpoint.get("embedding_dim", 768))
        hidden_dim = int(checkpoint.get("hidden_dim", 512))
        dropout = float(checkpoint.get("dropout", 0.30))

        self.classifier = HierarchicalClassifier(
            embedding_dim=embedding_dim,
            hidden_dim=hidden_dim,
            num_species=len(self.species_names),
            num_orders=len(self.order_names),
            dropout=dropout,
        )
        self.classifier.load_state_dict(checkpoint["model_state_dict"])
        self.classifier = self.classifier.to(self.device).eval()

        try:
            import open_clip
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "open_clip is required for taxonomy inference. "
                "Install open_clip_torch from requirements.txt."
            ) from exc

        self.bioclip, _, self.preprocess = open_clip.create_model_and_transforms(
            self.model_name
        )
        if "bioclip_state_dict" in checkpoint:
            self.bioclip.load_state_dict(checkpoint["bioclip_state_dict"])
        self.bioclip = self.bioclip.to(self.device).eval()
        for parameter in self.bioclip.parameters():
            parameter.requires_grad = False

    def _embed_paths(
        self,
        image_paths: dict[str, Path],
    ) -> tuple[list[str], torch.Tensor]:
        view_names = sorted(image_paths)
        tensors = []

        for view in view_names:
            with Image.open(image_paths[view]) as image:
                tensors.append(self.preprocess(image.convert("RGB")))

        images = torch.stack(tensors).to(self.device)

        with torch.inference_mode():
            embeddings = self.bioclip.encode_image(images).float()
            embeddings = F.normalize(embeddings, p=2, dim=-1)

        return view_names, embeddings

    def classify(self, image_paths: dict[str, Path]) -> dict[str, Any]:
        if not image_paths:
            raise ValueError("No specimen images were supplied")

        view_names, embeddings = self._embed_paths(image_paths)

        # Best-performing deployment path from the controlled BioKEA comparison:
        # direct hierarchical Order head + probability averaging across views.
        with torch.inference_mode():
            _, order_logits_by_view = self.classifier(embeddings)
            order_probs_by_view = torch.softmax(order_logits_by_view, dim=-1)
            order_probs = normalize_probabilities(order_probs_by_view.mean(dim=0))

            # Keep a species prediction from the same hierarchical checkpoint.
            # Species uses an averaged BioCLIP embedding and is informational only
            # because BioKEA currently has Order-level ground truth.
            averaged_embedding = F.normalize(
                embeddings.mean(dim=0, keepdim=True),
                p=2,
                dim=-1,
            )
            species_logits, _ = self.classifier(averaged_embedding)
            species_probs = torch.softmax(species_logits, dim=-1).squeeze(0)

        order_top3 = top_predictions(order_probs, self.order_names, k=3)
        species_top3 = top_predictions(species_probs, self.species_names, k=3)

        return {
            "model": "taxonomy_classifier",
            "kind": "hierarchical_direct_order",
            "fusion": "order_probability_average",
            "checkpoint": self.checkpoint_path.name,
            "views_used": view_names,
            "order": order_top3[0]["name"],
            "order_confidence": order_top3[0]["confidence"],
            "order_top3": order_top3,
            "species": species_top3[0]["name"],
            "species_confidence": species_top3[0]["confidence"],
            "species_top3": species_top3,
        }
