// Fleet "needs a look" (CONTRACTS §4.6). The registry is a seam owned by
// FL-01; the five producers under `producers/` are FL-03's.
export * from './needs-a-look.producer';
export * from './needs-a-look.service';
export * from './producers/consent-missing.producer';
export * from './producers/disk-low.producer';
export * from './producers/helper-untrusted.producer';
export * from './producers/node-quarantined.producer';
export * from './producers/node-throttled.producer';

import { ConsentMissingProducer } from './producers/consent-missing.producer';
import { DiskLowProducer } from './producers/disk-low.producer';
import { HelperUntrustedProducer } from './producers/helper-untrusted.producer';
import { NodeQuarantinedProducer } from './producers/node-quarantined.producer';
import { NodeThrottledProducer } from './producers/node-throttled.producer';

/** FL-03's producers, in the order the module registers them. */
export const FL03_NEEDS_A_LOOK_PRODUCERS = [
    DiskLowProducer,
    NodeThrottledProducer,
    NodeQuarantinedProducer,
    ConsentMissingProducer,
    HelperUntrustedProducer,
] as const;
