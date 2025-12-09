import { ProjectFile, DxfEntity, BeamStep4TopologyInfo } from '../../../types';
import { DEFAULT_BEAM_STAGE_COLORS } from './common';

export interface BeamCalculationResult {
  resultLayer: string;
  entities: DxfEntity[];
  infos: BeamStep4TopologyInfo[];
  colors: Record<string, string>;
  message: string;
}

/**
 * Pure calculation for Step 5: Final calculation/export placeholder.
 * Currently acts as a passthrough of Step4 topology infos into BEAM_CALC.
 */
export const calculateBeamCalculation = (
  activeProject: ProjectFile
): BeamCalculationResult | null => {
  const source = activeProject.beamStep4TopologyInfos;
  if (!source || source.length === 0) {
    return null;
  }
  const resultLayer = 'BEAM_CALC';
  const entities: DxfEntity[] = source.map(info => ({
    type: info.shape === 'rect' ?  'LWPOLYLINE' as const : 'LWPOLYLINE',
    layer: resultLayer,
    closed: true,
    vertices: info.vertices
  }));

  const colors: Record<string, string> = {
    [resultLayer]: DEFAULT_BEAM_STAGE_COLORS[resultLayer]
  };

  const message = `Step 5: Prepared ${entities.length} beams for final calculation.`;

  return {
    resultLayer,
    entities,
    infos: source,
    colors,
    message
  };
};
