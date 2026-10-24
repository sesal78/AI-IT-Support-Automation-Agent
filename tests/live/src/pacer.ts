import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Plan §4.1: at most 4 form-path submits in any 10 minutes. */
export const FORM_SUBMIT_LIMIT = 4;
export const FORM_WINDOW_MS = 10 * 60 * 1000;

/** Thrown when the pacer state file cannot be read. Names the file. */
export class PacerStateError extends Error {
  override readonly name = "PacerStateError";
  constructor(file: string) {
    super(`form pacer state file is corrupt: ${file}`);
  }
}

export interface FormPacer {
  /** Waits until a submit is allowed, then records it. */
  acquire(): Promise<void>;
}

export interface FormPacerOptions {
  /** The `.loop-evidence` folder; the state file is `<evidenceDir>/live/form-pacer.json`. */
  readonly evidenceDir: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const stateSchema = z.strictObject({ submits: z.array(z.number().int().nonnegative()) });

export function pacerStateFile(evidenceDir: string): string {
  return join(evidenceDir, "live", "form-pacer.json");
}

/**
 * Paces form-path submits. The window lives in a file, so two runs in a row
 * share it. Only submit times are stored.
 */
export function createFormPacer(options: FormPacerOptions): FormPacer {
  const file = pacerStateFile(options.evidenceDir);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  function read(): number[] {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new PacerStateError(file);
    }
    try {
      return stateSchema.parse(JSON.parse(text)).submits;
    } catch {
      throw new PacerStateError(file);
    }
  }

  function write(submits: number[]): void {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify({ submits }));
    renameSync(temp, file);
  }

  return {
    async acquire() {
      for (;;) {
        const at = now();
        const submits = read();
        // A submit in the future cannot come from this clock: the file is corrupt.
        if (submits.some((t) => t > at)) throw new PacerStateError(file);
        const recent = submits.filter((t) => at - t < FORM_WINDOW_MS).sort((a, b) => a - b);
        if (recent.length < FORM_SUBMIT_LIMIT) {
          write([...recent, at]);
          return;
        }
        // Wait until the oldest submit in the window is 10 minutes old.
        await sleep(Math.min(FORM_WINDOW_MS, recent[0]! + FORM_WINDOW_MS - at));
      }
    },
  };
}
