// Registry of bundled example models (JSON files in /examples). DOM-free; works in Node and under Vite.
import slope from '../../examples/slope.json' with { type: 'json' };
import footing from '../../examples/footing.json' with { type: 'json' };
import excavation from '../../examples/excavation.json' with { type: 'json' };
import embankment from '../../examples/embankment.json' with { type: 'json' };
import { cloneModel } from '../core/model.js';

const EXAMPLES = {
  slope: { title: 'Homogeneous slope (FOS by strength reduction)', model: slope },
  footing: { title: 'Strip footing on layered soil', model: footing },
  excavation: { title: 'Staged excavation (K0, then excavate)', model: excavation },
  embankment: { title: 'Embankment on soft clay with water table', model: embankment },
};

/** Names of the bundled examples. */
export const EXAMPLE_NAMES = Object.keys(EXAMPLES);

/** Human-readable catalogue [{name, title}]. */
export function listExamples() {
  return EXAMPLE_NAMES.map((name) => ({ name, title: EXAMPLES[name].title }));
}

/** A fresh deep copy of the named example model. Throws for unknown names. */
export function getExample(name) {
  const e = EXAMPLES[String(name).toLowerCase()];
  if (!e) throw new Error(`Unknown example "${name}". Available: ${EXAMPLE_NAMES.join(', ')}`);
  return cloneModel(e.model);
}
