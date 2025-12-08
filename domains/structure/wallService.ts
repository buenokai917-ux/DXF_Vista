import { ProjectFile, SemanticLayer, DxfEntity, EntityType, WallInfo, Bounds } from '../../types';
import { extractEntities } from '../../utils/dxfHelpers';
import { findParallelPolygons, getEntityBounds, distancePointToLine } from '../../utils/geometryUtils';
import { getMergeBaseBounds, filterEntitiesInBounds } from './common';

export interface WallCalculationResult {
  resultLayer: string;
  contextLayers: string[];
  entities: DxfEntity[];
  infos: WallInfo[];
  baseBounds: Bounds[] | null;
  thicknessSummary: string;
  message: string;
}

const estimateWallThicknesses = (lines: DxfEntity[]): Set<number> => {
  const thicknessCounts = new Map<number, number>();
  const VALID_THICKNESSES = [100, 120, 150, 180, 200, 240, 250, 300, 350, 370, 400, 500, 600];
  const sample = lines.length > 2000 ? lines.filter((_, i) => i % 2 === 0) : lines;

  for (let i = 0; i < sample.length; i++) {
    const l1 = sample[i];
    if (!l1.start || !l1.end) continue;
    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
    if (len1 < 100) continue;

    for (let j = i + 1; j < sample.length; j++) {
      const l2 = sample[j];
      if (!l2.start || !l2.end) continue;

      const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
      const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
      const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
      if (Math.abs(dot) < 0.98) continue;

      const center = { x: (l2.start.x + l2.end.x) / 2, y: (l2.start.y + l2.end.y) / 2 };
      const dist = distancePointToLine(center, l1.start, l1.end);

      if (dist > 50 && dist < 800) {
        const rounded = Math.round(dist / 10) * 10;
        thicknessCounts.set(rounded, (thicknessCounts.get(rounded) || 0) + 1);
      }
    }
  }

  const result = new Set<number>();
  thicknessCounts.forEach((count, thick) => {
    if (count > 2) {
      const isStandard = VALID_THICKNESSES.some(std => Math.abs(std - thick) <= 5);
      if (isStandard || count > 10) {
        result.add(thick);
      }
    }
  });

  return result;
};

const convertWallsToRectangles = (entities: DxfEntity[], layer: string): DxfEntity[] => {
  const pointInPolygon = (pt: any, vertices: any[]): boolean => {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i].x, yi = vertices[i].y;
      const xj = vertices[j].x, yj = vertices[j].y;

      const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  const makeRectangleEntity = (x1: number, x2: number, y1: number, y2: number, layerName: string): DxfEntity => {
    const c1 = { x: x1, y: y1 };
    const c2 = { x: x2, y: y1 };
    const c3 = { x: x2, y: y2 };
    const c4 = { x: x1, y: y2 };
    return {
      type: EntityType.LWPOLYLINE,
      layer: layerName,
      vertices: [c1, c2, c3, c4],
      closed: true
    };
  };

  const splitPolygonToRectangles = (poly: DxfEntity, layerName: string): DxfEntity[] => {
    if (!poly.vertices || poly.vertices.length < 4) return [];

    const xs = Array.from(new Set(poly.vertices.map(v => v.x))).sort((a, b) => a - b);
    const ys = Array.from(new Set(poly.vertices.map(v => v.y))).sort((a, b) => a - b);

    if (xs.length < 2 || ys.length < 2) return [];

    const insideGrid: boolean[][] = [];
    for (let y = 0; y < ys.length - 1; y++) {
      insideGrid[y] = [];
      for (let x = 0; x < xs.length - 1; x++) {
        const mid = { x: (xs[x] + xs[x + 1]) / 2, y: (ys[y] + ys[y + 1]) / 2 };
        insideGrid[y][x] = pointInPolygon(mid, poly.vertices!);
      }
    }

    const rectangles: DxfEntity[] = [];
    let activeRuns = new Map<string, { xStart: number, xEnd: number, yStart: number }>();

    for (let y = 0; y < ys.length - 1; y++) {
      const rowRuns: { xStart: number, xEnd: number }[] = [];
      let runStart: number | null = null;

      for (let x = 0; x < xs.length - 1; x++) {
        const filled = insideGrid[y][x];
        if (filled && runStart === null) {
          runStart = x;
        } else if (!filled && runStart !== null) {
          rowRuns.push({ xStart: runStart, xEnd: x });
          runStart = null;
        }
      }
      if (runStart !== null) {
        rowRuns.push({ xStart: runStart, xEnd: xs.length - 1 });
      }

      const nextActive = new Map<string, { xStart: number, xEnd: number, yStart: number }>();
      const rowKeys = new Set<string>();

      rowRuns.forEach(run => {
        const key = `${run.xStart}-${run.xEnd}`;
        rowKeys.add(key);
        if (activeRuns.has(key)) {
          nextActive.set(key, activeRuns.get(key)!);
        } else {
          nextActive.set(key, { ...run, yStart: y });
        }
      });

      activeRuns.forEach((val, key) => {
        if (!rowKeys.has(key)) {
          rectangles.push(makeRectangleEntity(xs[val.xStart], xs[val.xEnd], ys[val.yStart], ys[y], layerName));
        }
      });

      activeRuns = nextActive;
    }

    activeRuns.forEach(val => {
      rectangles.push(makeRectangleEntity(xs[val.xStart], xs[val.xEnd], ys[val.yStart], ys[ys.length - 1], layerName));
    });

    return rectangles;
  };

  const result: DxfEntity[] = [];
  entities.forEach(ent => {
    const isClosedPolygon = ent.type === EntityType.LWPOLYLINE && ent.closed && ent.vertices && ent.vertices.length > 2;
    if (isClosedPolygon) {
      const rects = splitPolygonToRectangles(ent, layer);
      if (rects.length > 0) {
        result.push(...rects);
      } else {
        result.push({ ...ent, layer });
      }
    } else {
      result.push(ent);
    }
  });
  return result;
};

/**
 * Pure wall calculation. Does not mutate React state.
 */
export const calculateWalls = (project: ProjectFile): WallCalculationResult | null => {
  const baseBounds = getMergeBaseBounds(project, 2500);
  const targetLayers = project.layerConfig[SemanticLayer.WALL];
  if (targetLayers.length === 0) {
    return null;
  }

  const columnLayers = project.layerConfig[SemanticLayer.COLUMN];
  let columnObstacles = extractEntities(columnLayers, project.data.entities, project.data.blocks, project.data.blockBasePoints);
  const calcColumns = extractEntities(['COLU_CALC'], project.data.entities, project.data.blocks, project.data.blockBasePoints);
  columnObstacles = [...columnObstacles, ...calcColumns];
  columnObstacles = filterEntitiesInBounds(columnObstacles, baseBounds);

  const axisLayers = project.layerConfig[SemanticLayer.AXIS];
  const rawAxisEntities = extractEntities(axisLayers, project.data.entities, project.data.blocks, project.data.blockBasePoints);
  let axisLines: DxfEntity[] = [];

  rawAxisEntities.forEach(ent => {
    if (ent.type === EntityType.LINE && ent.start && ent.end) {
      axisLines.push(ent);
    } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
      const verts = ent.vertices;
      for (let i = 0; i < verts.length - 1; i++) {
        axisLines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[i], end: verts[i + 1] });
      }
      if (ent.closed && verts.length > 2) {
        axisLines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[verts.length - 1], end: verts[0] });
      }
    }
  });

  axisLines = filterEntitiesInBounds(axisLines, baseBounds);

  const resultLayer = 'WALL_CALC';
  const contextLayers = ['AXIS', 'COLU', 'BEAM_CALC'];

  let rawWallEntities = extractEntities(targetLayers, project.data.entities, project.data.blocks, project.data.blockBasePoints);
  rawWallEntities = filterEntitiesInBounds(rawWallEntities, baseBounds);

  const candidateLines: DxfEntity[] = [];
  const existingClosedPolygons: DxfEntity[] = [];

  rawWallEntities.forEach(ent => {
    if (ent.type === EntityType.LWPOLYLINE && ent.closed && ent.vertices && ent.vertices.length > 2) {
      existingClosedPolygons.push({ ...ent, layer: resultLayer });
    } else {
      if (ent.type === EntityType.LINE && ent.start && ent.end) {
        candidateLines.push(ent);
      } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
        const verts = ent.vertices;
        for (let i = 0; i < verts.length; i++) {
          if (ent.closed && i === verts.length - 1) {
            const p1 = verts[i];
            const p2 = verts[0];
            candidateLines.push({ type: EntityType.LINE, layer: ent.layer, start: p1, end: p2 });
          } else if (i < verts.length - 1) {
            const p1 = verts[i];
            const p2 = verts[i + 1];
            candidateLines.push({ type: EntityType.LINE, layer: ent.layer, start: p1, end: p2 });
          }
        }
      }
    }
  });

  const estimatedWidths = estimateWallThicknesses(candidateLines);
  if (estimatedWidths.size === 0) {
    estimatedWidths.add(200);
    estimatedWidths.add(240);
    estimatedWidths.add(100);
  }
  const widthStr = Array.from(estimatedWidths).join(', ');

  const generatedWalls = findParallelPolygons(candidateLines, 600, resultLayer, columnObstacles, axisLines, [], 'WALL', estimatedWidths);
  const newEntities: DxfEntity[] = [...generatedWalls, ...existingClosedPolygons];

  if (newEntities.length === 0) {
    return null;
  }

  const rectangularWalls = convertWallsToRectangles(newEntities, resultLayer);

  if (rectangularWalls.length === 0) {
    return null;
  }

  const infos: WallInfo[] = rectangularWalls
    .map((e, idx) => {
      const b = getEntityBounds(e);
      if (!b) return null;
      const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      const thickness = Math.min(b.maxX - b.minX, b.maxY - b.minY);
      return {
        id: `WALL-${idx + 1}`,
        layer: e.layer,
        bounds: b,
        thickness,
        center
      };
    })
    .filter((w): w is WallInfo => Boolean(w));

  let message = `Marked ${rectangularWalls.length} wall rectangles. (Thicknesses: ${widthStr})`;
  if (baseBounds) message += ` (Restricted to ${baseBounds.length} merged regions)`;

  return { resultLayer, contextLayers, entities: rectangularWalls, infos, baseBounds, thicknessSummary: widthStr, message };
};
