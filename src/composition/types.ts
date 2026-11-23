// The marker registry as the composition sees it.
import { markerTypes } from '../../markers/index.generated';
import type { MarkerType } from '../markers/define';

export const TYPES = new Map<string, MarkerType>(markerTypes.map((t) => [t.type, t]));
export const typeOf = (type: string) => TYPES.get(type);
