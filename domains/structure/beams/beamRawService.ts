import { ProjectFile, DxfEntity } from '../../../types';
import { findParallelPolygons } from '../../../utils/geometryUtils';
import { collectBeamSources, mergeCollinearBeams, DEFAULT_BEAM_STAGE_COLORS } from './common';

export interface BeamRawCalculationResult {
  resultLayer: string;
  contextLayers: string[];
  entities: DxfEntity[];
  widthsUsed: number[];
  message: string;
}

/**
 * Pure calculation for Beam Raw Generation (Step 1). No state mutation.
 */
export const calculateBeamRawGeneration = (
  activeProject: ProjectFile,
  projects: ProjectFile[]
): BeamRawCalculationResult | null => {
  const sources = collectBeamSources(activeProject, projects);
  if (!sources) return null;

  const resultLayer = 'BEAM_STEP1_RAW';
  const contextLayers = ['AXIS'];
  const { lines, obstacles, axisLines, textPool, validWidths } = sources;
  const widthsToUse = validWidths.size > 0 ? validWidths : new Set([200, 250, 300, 350, 400, 500, 600]);

  const polys = findParallelPolygons(
    lines,
    1200,
    resultLayer,
    obstacles,
    axisLines,
    textPool,
    'BEAM',
    widthsToUse
  );

  if (polys.length === 0) {
    return null;
  }

  const mergedPolys = mergeCollinearBeams(polys, obstacles, [], 2, false);
  const widthsUsed = Array.from(widthsToUse).sort((a, b) => a - b);
  const message = `Step 1: Generated ${mergedPolys.length} raw beam segments. (Widths: ${widthsUsed.join(', ')})`;

  return {
    resultLayer,
    contextLayers,
    entities: mergedPolys.map(e => ({ ...e, layer: resultLayer })),
    widthsUsed,
    message,
  };
};
