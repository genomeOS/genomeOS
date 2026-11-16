/** The Keys help beside the camera buttons, for Atlas design §11 (#483: how to tilt). */

import { KEYBOARD_HELP, TILT_HELP } from '../../atlas/camera-help';

export function CameraHelp() {
  return (
    <details className="atlas-keyboard-help">
      <summary role="button">Keys</summary>
      {/* One paragraph: the help is a single popover above its trigger (atlas.css). */}
      <p>
        {KEYBOARD_HELP} {TILT_HELP}
      </p>
    </details>
  );
}
