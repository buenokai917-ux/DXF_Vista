import { ProjectFile, DxfEntity, EntityType, BeamStep2GeoInfo } from '../../../types';
import { getCenter, getEntityBounds } from '../../../utils/geometryUtils';
import {
  computeOBB,
  collectBeamSources,
  isBeamFullyAnchored,
  deepCopyEntities,
  extendBeamsToPerpendicular,
  mergeOverlappingBeams,
  detectIntersections,
  DEFAULT_BEAM_STAGE_COLORS
} from './common';

export interface BeamIntersectionResult {
  resultLayer: string;
  interLayer: string;
  entities: DxfEntity[];
  interEntities: DxfEntity[];
  interInfos: ReturnType<typeof detectIntersections>['info'];
  geoInfos: BeamStep2GeoInfo[];
  layersToHide: string[];
  contextLayers: string[];
  colors: Record<string, string>;
  message: string;
}

/**
 * Pure calculation for Step 2: Intersection Processing (no React/state).
 */
export const calculateBeamIntersectionProcessing = (
  activeProject: ProjectFile,
  projects: ProjectFile[]
): BeamIntersectionResult | null => {
  const sources = collectBeamSources(activeProject, projects);
  if (!sources) return null;

  const sourceLayer = 'BEAM_STEP1_RAW';
  const resultLayer = 'BEAM_STEP2_GEO';
  const interLayer = 'BEAM_STEP2_INTER_SECTION';

  const rawStep1 = activeProject.data.entities.filter(e => e.layer === sourceLayer);
  if (rawStep1.length === 0) {
    return null;
  }

  const workingSet = deepCopyEntities(rawStep1);

  const validWidthsArr = Array.from(sources.validWidths);
  const maxSearchWidth = validWidthsArr.length > 0 ? Math.max(...validWidthsArr) : 600;
  const strictViewports = activeProject.splitRegions ? activeProject.splitRegions.map(r => r.bounds) : [];

  const toProcess: DxfEntity[] = [];
  const completed: DxfEntity[] = [];

  workingSet.forEach(b => {
    if (isBeamFullyAnchored(b, sources.obstacles)) {
      completed.push(b);
    } else {
      toProcess.push(b);
    }
  });

  const allTargets = [...toProcess, ...completed];
  const extended = extendBeamsToPerpendicular(toProcess, allTargets, sources.obstacles, maxSearchWidth, strictViewports);

  let finalEntities = [...extended, ...completed].map(e => ({ ...e, layer: resultLayer }));
  if (finalEntities.length === 0) {
    finalEntities = workingSet.map(e => ({ ...e, layer: resultLayer }));
  }

  const mergedBeams = mergeOverlappingBeams(finalEntities);

  const labeledEntities: DxfEntity[] = [];
  mergedBeams.forEach((ent, idx) => {
    labeledEntities.push(ent);
    const center = getCenter(ent);
    const obb = computeOBB(ent);
    const angle = obb ? (Math.atan2(obb.u.y, obb.u.x) * 180) / Math.PI : 0;
    if (center) {
      labeledEntities.push({
        type: EntityType.TEXT,
        layer: resultLayer,
        start: center,
        text: `B2-${idx}`,
        radius: 200,
        startAngle: angle
      });
    }
  });

  const interMarks = detectIntersections(mergedBeams);
  const interEntities = [...interMarks.intersections, ...interMarks.labels].map(e => ({ ...e, layer: interLayer }));

  const geoInfos = mergedBeams.map((ent, idx) => {
    const b = getEntityBounds(ent)!;
    const obb = computeOBB(ent);
    return {
      id: `B2-${idx}`,
      layer: resultLayer,
      shape: 'rect',
      vertices: ent.vertices || [],
      bounds: { startX: b.minX, startY: b.minY, endX: b.maxX, endY: b.maxY },
      center: getCenter(ent) || undefined,
      radius: undefined,
      angle: obb ? (Math.atan2(obb.u.y, obb.u.x) * 180) / Math.PI : undefined,
      beamIndex: idx
    } as BeamStep2GeoInfo;
  });

  const colors: Record<string, string> = {
    [resultLayer]: DEFAULT_BEAM_STAGE_COLORS[resultLayer],
    [interLayer]: DEFAULT_BEAM_STAGE_COLORS[interLayer]
  };

  const message = `Step 2: Processed intersections. Result: ${labeledEntities.length} entities, ${interEntities.length} intersection marks.`;

  return {
    resultLayer,
    interLayer,
    entities: labeledEntities,
    interEntities,
    interInfos: interMarks.info,
    geoInfos,
    layersToHide: [sourceLayer],
    contextLayers: ['AXIS', 'COLU_CALC', 'WALL_CALC'],
    colors,
    message
  };
};
