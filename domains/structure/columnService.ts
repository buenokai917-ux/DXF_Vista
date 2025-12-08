import { ProjectFile, SemanticLayer, DxfEntity, EntityType, ColumnInfo, Bounds } from '../../types';
import { extractEntities } from '../../utils/dxfHelpers';
import { getEntityBounds } from '../../utils/geometryUtils';
import { getMergeBaseBounds, filterEntitiesInBounds } from './common';

export interface ColumnCalculationResult {
  resultLayer: string;
  contextLayers: string[];
  entities: DxfEntity[];
  infos: ColumnInfo[];
  baseBounds: Bounds[] | null;
  message: string;
}

/**
 * Pure column calculation. Does not mutate React state.
 */
export const calculateColumns = (project: ProjectFile): ColumnCalculationResult | null => {
  const baseBounds = getMergeBaseBounds(project, 2500);
  const targetLayers = project.layerConfig[SemanticLayer.COLUMN];
  const resultLayer = 'COLU_CALC';
  const contextLayers = ['AXIS', 'WALL_CALC', 'BEAM_CALC'];

  if (targetLayers.length === 0) {
    return null;
  }

  let rawEntities = extractEntities(targetLayers, project.data.entities, project.data.blocks, project.data.blockBasePoints);
  rawEntities = filterEntitiesInBounds(rawEntities, baseBounds);

  const entities = rawEntities
    .filter(e => (e.type === EntityType.LWPOLYLINE && e.closed) || e.type === EntityType.CIRCLE || e.type === EntityType.INSERT)
    .map(e => ({ ...e, layer: resultLayer }));

  const infos: ColumnInfo[] = entities
    .map((e, idx) => {
      const b = getEntityBounds(e);
      if (!b) return null;
      const width = b.maxX - b.minX;
      const height = b.maxY - b.minY;
      const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      return {
        id: `COL-${idx + 1}`,
        layer: e.layer,
        bounds: b,
        width,
        height,
        center
      };
    })
    .filter((c): c is ColumnInfo => Boolean(c));

  if (entities.length === 0) {
    return null;
  }

  let message = `Marked ${entities.length} columns.`;
  if (baseBounds) message += ` (Restricted to ${baseBounds.length} merged regions)`;

  return { resultLayer, contextLayers, entities, infos, baseBounds, message };
};
