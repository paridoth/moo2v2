import type { StrategicPolicy } from './types';
import { expanderStrategy } from './strategy';
import { strategistStrategy } from './strategist';
import { admiralStrategy } from './admiral';

/** Persisted policy ids select continuation behavior. Never silently upgrade
 * an existing campaign; replay itself does not call either policy. */
export function policyFor(id: StrategicPolicy['id']): StrategicPolicy {
  switch (id) {
    case 'expander-v1': return expanderStrategy;
    case 'strategist-v2': return strategistStrategy;
    case 'strategist-v3': return admiralStrategy;
    default: throw new Error(`Unsupported Orion strategy: ${String(id)}`);
  }
}
