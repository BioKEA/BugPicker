import json

from java.io import BufferedReader, File, FileWriter, InputStreamReader
from java.util.concurrent.atomic import AtomicBoolean
from java.lang import ProcessBuilder, Thread
from javax.swing import JButton, JFrame, JLabel, JPanel, JProgressBar
from javax.imageio import ImageIO
from java.awt import BorderLayout
from org.openpnp.model import LengthUnit, Location
from org.openpnp.spi.MotionPlanner import CompletionType
from org.openpnp.util.UiUtils import submitUiMachineTask


START_X = 323.0
START_Y = 288.0
END_X = 403.0
END_Y = 398.0

LANE_WIDTH_MM = 10.0
PAUSE_EVERY_MM = 10.0
SETTLE_SECONDS = 0.2
PAUSE_SECONDS = 1.0
XY_HOME_COMMAND = "G28 X Y"
XY_HOME_TIMEOUT_MS = 60000
DRIVER_TIMEOUT_MS = 60000

PYTHON = "/home/chris/miniforge3/bin/python3"
DETECTOR_SCRIPT = "/home/chris/.openpnp2/scripts/bugpicker_detect.py"
SNAPSHOT_DIR = "/home/chris/.openpnp2/snapshots/bugpicker"
DETECTIONS_CSV = "/home/chris/.openpnp2/snapshots/bugpicker/detections_boxed.csv"

halt_requested = AtomicBoolean(False)
progress_frame = None
progress_bar = None
progress_label = None
original_allow_unhomed_motion = None


def make_location(x, y, template_location):
    return Location(
        LengthUnit.Millimeters,
        x,
        y,
        template_location.getZ(),
        template_location.getRotation(),
    )


def inclusive_range(start, end, step):
    values = []
    value = start

    if start > end:
        step = -abs(step)
        while value >= end:
            values.append(value)
            value += step
    else:
        step = abs(step)
        while value <= end:
            values.append(value)
            value += step

    if values[-1] != end:
        values.append(end)

    return values


def move_camera_to(camera, x, y, template_location):
    gui.setStatus("Moving top camera to X %.3f, Y %.3f" % (x, y))
    camera.moveTo(make_location(x, y, template_location))


def wait_for_camera_to_settle():
    gui.setStatus("Waiting %.1f seconds for camera to settle" % SETTLE_SECONDS)
    Thread.sleep(int(SETTLE_SECONDS * 1000))


def home_xy_only():
    update_progress("Homing X/Y axes only", 0, 1)
    driver = machine.getDrivers().get(0)
    driver.sendCommand(XY_HOME_COMMAND, XY_HOME_TIMEOUT_MS)
    driver.waitForCompletion(None, CompletionType.WaitForStillstandIndefinitely)
    machine.setHomed(True)


def find_declared_field(obj, field_name):
    cls = obj.getClass()
    while cls is not None:
        try:
            field = cls.getDeclaredField(field_name)
            field.setAccessible(True)
            return field
        except:
            cls = cls.getSuperclass()
    return None


def set_allow_unhomed_motion(driver, enabled):
    field = find_declared_field(driver, "allowUnhomedMotion")
    if field is None:
        print("Could not find allowUnhomedMotion field on driver")
        return None

    old_value = field.getBoolean(driver)
    field.setBoolean(driver, enabled)
    return old_value


def enable_script_managed_xy_home_motion():
    global original_allow_unhomed_motion

    driver = machine.getDrivers().get(0)
    original_allow_unhomed_motion = set_allow_unhomed_motion(driver, True)
    update_progress("Script-managed XY home motion enabled", 0, 1)


def restore_driver_motion_guard():
    if original_allow_unhomed_motion is None:
        return

    driver = machine.getDrivers().get(0)
    set_allow_unhomed_motion(driver, original_allow_unhomed_motion)


def configure_driver_timeout():
    driver = machine.getDrivers().get(0)
    try:
        driver.setTimeoutMilliseconds(DRIVER_TIMEOUT_MS)
        update_progress("Driver timeout set to %d ms" % DRIVER_TIMEOUT_MS, 0, 1)
    except:
        print("Could not set driver timeout; continuing with configured timeout")


def create_progress_ui():
    global progress_frame, progress_bar, progress_label

    progress_frame = JFrame("Bug Picker Scan")
    progress_frame.setSize(360, 120)
    progress_frame.setAlwaysOnTop(True)

    progress_label = JLabel("Ready")
    progress_bar = JProgressBar(0, 100)
    progress_bar.setStringPainted(True)

    halt_button = JButton("Halt")
    halt_button.addActionListener(lambda event: request_halt())

    panel = JPanel(BorderLayout(6, 6))
    panel.add(progress_label, BorderLayout.NORTH)
    panel.add(progress_bar, BorderLayout.CENTER)
    panel.add(halt_button, BorderLayout.SOUTH)

    progress_frame.add(panel)
    progress_frame.setLocationRelativeTo(None)
    progress_frame.setVisible(True)


def request_halt():
    halt_requested.set(True)
    update_progress("Halt requested; stopping after current operation", None, None)


def update_progress(message, current, total):
    gui.setStatus(message)

    if progress_label is not None:
        progress_label.setText(message)

    if progress_bar is not None and current is not None and total is not None:
        progress_bar.setMaximum(total)
        progress_bar.setValue(current)
        progress_bar.setString("%d / %d" % (current, total))


def check_halt():
    if halt_requested.get():
        update_progress("Bug picker scan halted", None, None)
        return True
    return False


def capture_snapshot(camera, lane_index, point_index, x, y):
    snapshot_dir = File(SNAPSHOT_DIR)
    snapshot_dir.mkdirs()

    image = camera.capture()
    filename = "lane_%02d_point_%02d_x_%07.3f_y_%07.3f.png" % (
        lane_index + 1,
        point_index + 1,
        x,
        y,
    )
    output_file = File(snapshot_dir, filename)
    ImageIO.write(image, "png", output_file)
    return output_file.getAbsolutePath(), image.getWidth(), image.getHeight()


def read_process_output(stream):
    reader = BufferedReader(InputStreamReader(stream))
    lines = []
    line = reader.readLine()
    while line is not None:
        lines.append(line)
        line = reader.readLine()
    return "\n".join(lines)


def detect_black_rectangles(image_path):
    process = ProcessBuilder([PYTHON, DETECTOR_SCRIPT, image_path]).start()
    stdout = read_process_output(process.getInputStream())
    stderr = read_process_output(process.getErrorStream())
    exit_code = process.waitFor()

    if exit_code != 0:
        raise RuntimeError(
            "Detector failed with exit code %d: %s" % (exit_code, stderr)
        )

    result = json.loads(stdout)
    if not result.get("found"):
        return []

    detections = []
    for detection in result.get("detections", []):
        detections.append(
            {
                "id": int(detection.get("id", len(detections) + 1)),
                "centroid_x_px": float(detection["centroid_px"][0]),
                "centroid_y_px": float(detection["centroid_px"][1]),
                "area_px": float(detection["area_px"]),
                "annotated_image_path": detection.get("annotated_image_path", ""),
            }
        )

    return detections


def get_units_per_pixel(camera):
    units_per_pixel = camera.getUnitsPerPixelAtZ()
    return units_per_pixel.getX(), units_per_pixel.getY()


def pixel_to_machine_xy(scan_x, scan_y, image_width, image_height, centroid_x, centroid_y, camera):
    units_per_pixel_x, units_per_pixel_y = get_units_per_pixel(camera)
    offset_x = (centroid_x - (image_width / 2.0)) * units_per_pixel_x
    offset_y = (centroid_y - (image_height / 2.0)) * units_per_pixel_y
    return scan_x + offset_x, scan_y + offset_y


def append_detection(row):
    output_file = File(DETECTIONS_CSV)
    new_file = not output_file.exists()
    writer = FileWriter(output_file, True)

    if new_file:
        writer.write(
            "lane,point,detection_id,scan_x_mm,scan_y_mm,centroid_x_px,centroid_y_px,"
            "centroid_x_mm,centroid_y_mm,area_px,image_path,annotated_image_path\n"
        )

    writer.write(
        "%d,%d,%d,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.1f,%s,%s\n"
        % (
            row["lane"],
            row["point"],
            row["detection_id"],
            row["scan_x_mm"],
            row["scan_y_mm"],
            row["centroid_x_px"],
            row["centroid_y_px"],
            row["centroid_x_mm"],
            row["centroid_y_mm"],
            row["area_px"],
            row["image_path"],
            row["annotated_image_path"],
        )
    )
    writer.close()


File(SNAPSHOT_DIR).mkdirs()


def run_scan():
    try:
        camera = machine.defaultHead.defaultCamera
        configure_driver_timeout()
        home_xy_only()
        enable_script_managed_xy_home_motion()
        if check_halt():
            return

        current_location = camera.getLocation()

        lane_ys = inclusive_range(START_Y, END_Y, LANE_WIDTH_MM)
        scan_points = []
        for lane_index, y in enumerate(lane_ys):
            if lane_index % 2 == 0:
                lane_xs = inclusive_range(START_X, END_X, PAUSE_EVERY_MM)
            else:
                lane_xs = inclusive_range(END_X, START_X, PAUSE_EVERY_MM)

            for point_index, x in enumerate(lane_xs):
                scan_points.append((lane_index, point_index, x, y))

        total_points = len(scan_points)
        detections = []

        for scan_index, scan_point in enumerate(scan_points):
            if check_halt():
                return

            lane_index, point_index, x, y = scan_point
            update_progress(
                "Lane %d/%d point %d: X %.3f, Y %.3f"
                % (lane_index + 1, len(lane_ys), point_index + 1, x, y),
                scan_index,
                total_points,
            )
            move_camera_to(camera, x, y, current_location)
            if check_halt():
                return

            wait_for_camera_to_settle()
            if check_halt():
                return

            saved_path, image_width, image_height = capture_snapshot(
                camera,
                lane_index,
                point_index,
                x,
                y,
            )

            frame_detections = detect_black_rectangles(saved_path)
            if frame_detections:
                found_count = len(frame_detections)
                for detection in frame_detections:
                    centroid_x_mm, centroid_y_mm = pixel_to_machine_xy(
                        x,
                        y,
                        image_width,
                        image_height,
                        detection["centroid_x_px"],
                        detection["centroid_y_px"],
                        camera,
                    )
                    row = {
                        "lane": lane_index + 1,
                        "point": point_index + 1,
                        "detection_id": detection["id"],
                        "scan_x_mm": x,
                        "scan_y_mm": y,
                        "centroid_x_px": detection["centroid_x_px"],
                        "centroid_y_px": detection["centroid_y_px"],
                        "centroid_x_mm": centroid_x_mm,
                        "centroid_y_mm": centroid_y_mm,
                        "area_px": detection["area_px"],
                        "image_path": saved_path,
                        "annotated_image_path": detection["annotated_image_path"],
                    }
                    detections.append(row)
                    append_detection(row)
                    print(
                        "Black rectangle %d centroid: X %.3f, Y %.3f in %s"
                        % (detection["id"], centroid_x_mm, centroid_y_mm, saved_path)
                    )

                centroid_x_mm, centroid_y_mm = pixel_to_machine_xy(
                    x,
                    y,
                    image_width,
                    image_height,
                    frame_detections[0]["centroid_x_px"],
                    frame_detections[0]["centroid_y_px"],
                    camera,
                )
                update_progress(
                    "Found %d rectangle(s); first at X %.3f, Y %.3f"
                    % (found_count, centroid_x_mm, centroid_y_mm),
                    scan_index + 1,
                    total_points,
                )
            else:
                update_progress(
                    "No rectangle at X %.3f, Y %.3f" % (x, y),
                    scan_index + 1,
                    total_points,
                )

            Thread.sleep(int(PAUSE_SECONDS * 1000))

        update_progress(
            "Raster scan complete; %d detections" % len(detections),
            total_points,
            total_points,
            )
    finally:
        restore_driver_motion_guard()


create_progress_ui()
submitUiMachineTask(run_scan)
