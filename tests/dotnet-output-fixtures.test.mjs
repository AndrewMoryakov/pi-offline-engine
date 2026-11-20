// What the main model sees from real dotnet output. Each fixture in
// tests/fixtures/dotnet-output/ is console output captured on Linux with .NET
// SDK 10.0.404 (paths and machine names replaced); build-detailed.txt is a
// cut of a 293 KB `-v d` log that keeps its start, its end and every line
// mentioning an error or a failure. For each fixture the test names the facts
// that must survive compaction and a size the summary must stay under.
//
// Only summarizeDotnetOutput is imported, so this file also runs against the
// keyword-only summary that came before the shared reader. There every case
// fails for want of a verdict line, and the detailed build, xUnit, NUnit and
// MTP cases also lose the facts listed for them.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { summarizeDotnetOutput } from "../src/tool-result-compactor.mjs";

const FIXTURES = new URL("./fixtures/dotnet-output/", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, FIXTURES), "utf8");

const CASES = [
  {
    file: "build-errors.txt",
    maxChars: 1200,
    facts: [
      /^Result: Build FAILED, 3 errors, 44 warnings$/m,
      "LibErr/Broken.cs(3,28): error CS0103: The name 'UnknownMethod' does not exist in the current context",
      "LibErr/Broken.cs(4,35): error CS0029: Cannot implicitly convert type 'string' to 'int'",
      "LibErr/Broken.cs(5,40): error CS0246"
    ],
    absent: [/\[\/work\/lab\/LibErr\/LibErr\.csproj\]/]
  },
  {
    file: "build-warnings.txt",
    maxChars: 800,
    facts: [/^Result: Build succeeded, 44 warnings$/m, /CS8618 x40, first: Lib\/Warn\.cs/, /CS8600 x4, first: Lib\/Calc\.cs/]
  },
  {
    file: "build-detailed.txt",
    maxChars: 400,
    facts: [/^Result: Build succeeded, 0 warnings$/m],
    absent: [/MSB4276/, /FAILED/]
  },
  {
    file: "test-compile-errors.txt",
    maxChars: 600,
    belowThreshold: true,
    facts: [/^Result: Build FAILED, 2 errors/m, "ETests/BrokenTests.cs(3,57): error CS0117", "ETests/BrokenTests.cs(4,39): error CS0029"]
  },
  {
    file: "test-xunit-failures.txt",
    maxChars: 2000,
    facts: [
      /^Result: Tests FAILED, 22 failed, 1 passed, 0 skipped of 23$/m,
      /^ {2}XTests\.CalcTests\.AddsZero\n {4}Assert\.Equal\(\) Failure: Values differ\n {4}Expected: 0\n {4}Actual: {3}1\n {4}at XTests\.CalcTests\.AddsZero\(\) in XTests\/UnitTest1\.cs:line 4$/m,
      /Also failed \(17\), first message like "Assert\.Equal\(\) Failure: Values differ": /,
      ...Array.from({ length: 20 }, (_, i) => new RegExp(`XTests\\.ManyTests\\.Case${i + 1}\\b`))
    ]
  },
  {
    file: "test-nunit-failures.txt",
    maxChars: 1600,
    facts: [
      /^Result: Tests FAILED, 20 failed, 1 passed, 0 skipped of 21$/m,
      /^ {2}Case1\n {4}Assert\.That\(Lib\.Calc\.Add\(1, 0\), Is\.EqualTo\(1\)\)\n {4}Expected: 1\n {4}But was: {2}2\n {4}at NTests\.ManyTests\.Case1\(\) in NTests\/ManyTests\.cs:line 3$/m,
      /Also failed \(15\), first message like "Assert\.That\(Lib\.Calc\.Add\(14, 0\), Is\.EqualTo\(14\)\)": Case14, Case15/
    ],
    // Below the 8000-character threshold, so the compactor would pass it
    // through unchanged; summarised here directly.
    belowThreshold: true
  },
  {
    file: "test-mstest-failures.txt",
    maxChars: 2000,
    facts: [
      /^Result: Tests FAILED, 22 failed, 0 passed, 0 skipped of 22$/m,
      "Assert.AreEqual failed. Expected:<7>. Actual:<8>.",
      "at MTests.ManyTests.Case7() in MTests/ManyTests.cs:line 9"
    ],
    absent: [/Microsoft\.VisualStudio\.TestTools/]
  },
  {
    file: "test-mtp-failure.txt",
    cwd: "/work/lab/fx",
    maxChars: 800,
    belowThreshold: true,
    facts: [
      /^Result: Tests FAILED, 1 failed, 3 passed, 0 skipped of 4$/m,
      /^ {4}expected: 100\n {4}actual: {3}90\.00$/m,
      "at Acceptance.Tests.LoyaltyDiscountTests.ExactlyThresholdIsNotDiscounted() in tests/Acceptance.Tests/LoyaltyDiscountTests.cs:line 11"
    ]
  },
  {
    file: "test-host-crash.txt",
    maxChars: 600,
    facts: [/^Result: Test run ABORTED$/m, "Test host process crashed", "boom from test", "at CTests.CrashTests.Crash()"],
    absent: [/System\.Environment\.FailFast/]
  }
];

for (const fixture of CASES) {
  test(`compacted ${fixture.file} keeps its facts within ${fixture.maxChars} characters`, () => {
    const text = read(fixture.file);
    if (!fixture.belowThreshold) assert.ok(text.length >= 8000, `${fixture.file} is large enough to be compacted`);
    const summary = summarizeDotnetOutput(text, {
      command: "dotnet test",
      artifact: ".pi/offline-engine/tool-results/x.log",
      cwd: fixture.cwd ?? "/work/lab"
    });
    for (const fact of fixture.facts) {
      if (typeof fact === "string") assert.ok(summary.includes(fact), `missing: ${fact}\n---\n${summary}`);
      else assert.match(summary, fact);
    }
    for (const pattern of fixture.absent ?? []) assert.doesNotMatch(summary, pattern);
    assert.ok(summary.length <= fixture.maxChars, `${summary.length} > ${fixture.maxChars}\n---\n${summary}`);
    assert.match(summary.split("\n")[1], /^Result: /, "the verdict is the line after the header");
  });
}
