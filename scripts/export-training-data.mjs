#!/usr/bin/env node
import process from "node:process";
import { exportTrainingData } from "../src/training-exporter.mjs";

const cwd = process.cwd();
const result = await exportTrainingData({ cwd });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
