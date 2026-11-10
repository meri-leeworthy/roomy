/**
 * A process that starts the lag sampler and then has no other work: it must
 * exit on its own. Run as a child by `eventLoopLag.test.ts` — an unref'd
 * interval that still held the loop open would hang here, and a test process
 * that hangs on teardown is the same defect one process removed.
 */

import { EventLoopLagSampler } from "./eventLoopLag.ts";

const sampler = new EventLoopLagSampler(20);
sampler.start();
