// One recorder per test file. Tests import it to register mocks and to read the
// run ID; the setup file starts it and runs the clean check after every test.
import { createEgressRecorder } from "../../../packages/shared/test-support/egress-recorder.js";

export const egress = createEgressRecorder();
