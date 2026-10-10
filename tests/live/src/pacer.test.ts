import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFormPacer, FORM_WINDOW_MS, pacerStateFile, PacerStateError } from "./pacer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function evidenceDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "live-pacer-")), ".loop-evidence");
  dirs.push(dirname(dir));
  return dir;
}

/** A fake clock whose sleep advances time and records each wait. */
function fakeClock(start = 1_000_000) {
  let time = start;
  const waits: number[] = [];
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    waits,
  };
}

describe("createFormPacer", () => {
  it("allows 4 submits in 10 minutes; the 5th waits until the oldest is 10 minutes old", async () => {
    const dir = evidenceDir();
    const clock = fakeClock();
    const pacer = createFormPacer({ evidenceDir: dir, now: clock.now, sleep: clock.sleep });
    const first = clock.now();
    for (let i = 0; i < 4; i++) {
      await pacer.acquire();
      clock.advance(60_000);
    }
    expect(clock.waits).toEqual([]);
    await pacer.acquire();
    expect(clock.waits).toEqual([first + FORM_WINDOW_MS - (first + 240_000)]);
    expect(clock.now()).toBe(first + FORM_WINDOW_MS);
  });

  it("keeps its state under .loop-evidence/live, and a new pacer continues the same window", async () => {
    const dir = evidenceDir();
    const clock = fakeClock();
    const one = createFormPacer({ evidenceDir: dir, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 4; i++) await one.acquire();
    const file = pacerStateFile(dir);
    expect(file).toBe(join(dir, "live", "form-pacer.json"));
    expect(JSON.parse(readFileSync(file, "utf8")).submits).toHaveLength(4);

    const two = createFormPacer({ evidenceDir: dir, now: clock.now, sleep: clock.sleep });
    await two.acquire();
    expect(clock.waits).toEqual([FORM_WINDOW_MS]);
  });

  it("forgets submits older than the window", async () => {
    const dir = evidenceDir();
    const clock = fakeClock();
    const pacer = createFormPacer({ evidenceDir: dir, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 4; i++) await pacer.acquire();
    clock.advance(FORM_WINDOW_MS);
    await pacer.acquire();
    expect(clock.waits).toEqual([]);
    expect(JSON.parse(readFileSync(pacerStateFile(dir), "utf8")).submits).toHaveLength(1);
  });

  it.each([["not json"], ['{"submits":"x"}'], ['{"submits":[1],"extra":1}'], ["[]"]])(
    "throws PacerStateError naming the file for a corrupt state: %s",
    async (content) => {
      const dir = evidenceDir();
      const file = pacerStateFile(dir);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      const pacer = createFormPacer({ evidenceDir: dir });
      const error = await pacer.acquire().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PacerStateError);
      expect((error as Error).message).toContain(file);
    },
  );

  it("names the file when the state path cannot be read", async () => {
    const dir = evidenceDir();
    const file = pacerStateFile(dir);
    mkdirSync(file, { recursive: true }); // a folder where the file should be
    await expect(createFormPacer({ evidenceDir: dir }).acquire()).rejects.toThrow(file);
  });

  it("uses a real timer by default", async () => {
    const dir = evidenceDir();
    const pacer = createFormPacer({ evidenceDir: dir });
    await pacer.acquire();
    expect(JSON.parse(readFileSync(pacerStateFile(dir), "utf8")).submits).toHaveLength(1);
  });
});
