#!/usr/bin/env node
/**
 * Q3c CLI — run local dual-commit shadow calibration harness.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import {
  ShadowCalibrationError,
  runLocalDualCommitCalibration,
} from './lib/shadowRequiredCalibration.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  const { result, receiptPaths, calibrationReceiptPath } = runLocalDualCommitCalibration(repoRoot);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        status: result.status,
        promoted_tier: result.promoted_tier,
        pr_blocker_claimed: result.pr_blocker_claimed,
        consecutive_pass_count: result.consecutive_pass_count,
        distinct_commit_count: result.distinct_commit_count,
        receipts: receiptPaths,
        calibration_receipt: calibrationReceiptPath,
      },
      null,
      2
    )
  );
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(error instanceof ShadowCalibrationError ? 1 : 2);
}
