/**
 * machine-id-header middleware — echoes this machine's Fly machine id on
 * every response so external observers (e.g. k6 load tests) can attribute a
 * response to the machine that served it.
 *
 * Fly does not itself expose a machine-id response header — a `fly-machine-id`
 * header was assumed to exist (issue #6653) but does not; the live endpoint's
 * response headers are `fly-request-id`, `server`, `x-powered-by`,
 * `x-content-type-options` only, and `fly-request-id` carries a region
 * suffix rather than a machine id (issue #6660). Fly does inject
 * `FLY_MACHINE_ID` into every machine's environment, so the app echoes it
 * itself instead.
 *
 * The header is omitted entirely (not sent empty) when `FLY_MACHINE_ID` is
 * unset, so local dev and tests are unaffected.
 */

import type { Request, Response, NextFunction } from 'express';

export const MACHINE_ID_HEADER_NAME = 'x-ezforge-machine';

export function machineIdHeaderMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const machineId = process.env['FLY_MACHINE_ID'];
  if (machineId) {
    res.set(MACHINE_ID_HEADER_NAME, machineId);
  }
  next();
}
