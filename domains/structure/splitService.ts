import { DxfData, DxfEntity, EntityType, ProjectFile, SemanticLayer, ViewportRegion } from '../../types';
import { extractEntities } from '../../utils/dxfHelpers';
import { prioritizeLayers } from './common';
import { findTitleForBounds, getEntityBounds, groupEntitiesByProximity, parseViewportTitle } from '../../utils/geometryUtils';

export interface SplitCalculationResult {
  regions: ViewportRegion[];
  resultLayer: string;
  debugLayer: string;
  updatedData: DxfData;
}

/**
 * Pure calculation for Split Views. No state mutation or UI calls.
 */
export const calculateSplitRegions = (
  project: ProjectFile,
  suppressAlert = false
): SplitCalculationResult | null => {
  const resultLayer = 'VIEWPORT_CALC';
  const debugLayer = 'VIEWPORT_DEBUG';

  const axisLayers = [
    ...project.layerConfig[SemanticLayer.AXIS],
    ...project.layerConfig[SemanticLayer.AXIS_OTHER]
  ];

  if (axisLayers.length === 0) {
    if (!suppressAlert) alert('No AXIS layers configured. Please check Layer Configuration.');
    return null;
  }

  const axisLines = extractEntities(axisLayers, project.data.entities, project.data.blocks, project.data.blockBasePoints)
    .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

  if (axisLines.length === 0) {
    if (!suppressAlert) console.log('No AXIS lines found in configured layers.');
    return null;
  }

  const titleLayers = project.layerConfig[SemanticLayer.VIEWPORT_TITLE];
  const useSpecificTitleLayers = titleLayers.length > 0;

  const allText = extractEntities(
    useSpecificTitleLayers ? titleLayers : project.data.layers,
    project.data.entities,
    project.data.blocks,
    project.data.blockBasePoints
  ).filter(e => e.type === EntityType.TEXT);

  const allLines = extractEntities(project.data.layers, project.data.entities, project.data.blocks, project.data.blockBasePoints)
    .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

  const clusters = groupEntitiesByProximity(axisLines, 5000);

  const newEntities: DxfEntity[] = [];
  const debugEntities: DxfEntity[] = [];
  const regions: ViewportRegion[] = [];

  clusters.forEach((box, i) => {
    const { title, scannedBounds } = findTitleForBounds(box, allText, allLines, useSpecificTitleLayers ? '' : undefined);
    const label = title || `BLOCK ${i + 1}`;

    regions.push({
      bounds: box,
      title: label,
      info: parseViewportTitle(label)
    });

    const rect: DxfEntity = {
      type: EntityType.LWPOLYLINE,
      layer: resultLayer,
      closed: true,
      vertices: [
        { x: box.minX, y: box.minY },
        { x: box.maxX, y: box.minY },
        { x: box.maxX, y: box.maxY },
        { x: box.minX, y: box.maxY }
      ]
    };
    newEntities.push(rect);

    newEntities.push({
      type: EntityType.TEXT,
      layer: resultLayer,
      text: label,
      start: { x: box.minX, y: box.maxY + 500 },
      radius: 250
    });

    scannedBounds.forEach(sb => {
      debugEntities.push({
        type: EntityType.LWPOLYLINE,
        layer: debugLayer,
        closed: true,
        vertices: [
          { x: sb.minX, y: sb.minY },
          { x: sb.maxX, y: sb.minY },
          { x: sb.maxX, y: sb.maxY },
          { x: sb.minX, y: sb.maxY }
        ]
      });
    });
  });

  if (newEntities.length === 0) {
    if (!suppressAlert) console.log('Could not determine split regions.');
    return null;
  }

  const updatedData: DxfData = {
    ...project.data,
    entities: [...project.data.entities, ...newEntities, ...debugEntities],
    layers: prioritizeLayers(project.data.layers, [resultLayer, debugLayer])
  };

  return {
    regions,
    resultLayer,
    debugLayer,
    updatedData
  };
};
