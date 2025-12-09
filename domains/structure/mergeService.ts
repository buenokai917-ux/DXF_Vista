import { Bounds, BeamLabelInfo, DxfData, DxfEntity, EntityType, Point, ProjectFile, SemanticLayer, ViewportRegion } from '../../types';
import { extractEntities } from '../../utils/dxfHelpers';
import { calculateMergeVector, getEntityBounds, getGridIntersections } from '../../utils/geometryUtils';
import { boundsOverlap, expandBounds, isPointInBounds } from './common';

export const MERGE_RESULT_LAYER_H = 'MERGE_LABEL_H';
export const MERGE_RESULT_LAYER_V = 'MERGE_LABEL_V';
export const MERGE_RESULT_LAYER_COLORS: Record<string, string> = {
  [MERGE_RESULT_LAYER_H]: '#00FFFF',
  [MERGE_RESULT_LAYER_V]: '#FF00FF'
};

export interface MergeCalculationResult {
  updatedData: DxfData;
  layersAdded: string[];
  beamLabels: BeamLabelInfo[];
  mergedCount: number;
}

/**
 * Pure calculation for Merge Views. No React state mutation.
 */
export const calculateMergeViews = (project: ProjectFile): MergeCalculationResult | null => {
  const regions = project.splitRegions;

  if (!regions || regions.length === 0) {
    return null;
  }

  // Only merge viewports that look like beam drawings (梁 / beam / X向 / Y向)
  const isBeamViewportName = (name: string) => {
    const upper = name.toUpperCase();
    return name.includes('梁') || upper.includes('BEAM') || name.includes('X向') || name.includes('Y向');
  };

  const beamRegions = regions.filter(r => isBeamViewportName(r.title || ''));
  if (beamRegions.length === 0) {
    return null;
  }

  const axisLayers = project.layerConfig[SemanticLayer.AXIS];
  const axisLines = extractEntities(axisLayers, project.data.entities, project.data.blocks, project.data.blockBasePoints)
    .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

  const groups: Record<string, ViewportRegion[]> = {};
  beamRegions.forEach(r => {
    const key = r.info ? r.info.prefix : r.title;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  const mergedEntities: DxfEntity[] = [];
  const mergedByLayer: Record<string, DxfEntity[]> = {};
  const allEntities = extractEntities(project.data.layers, project.data.entities, project.data.blocks, project.data.blockBasePoints);

  let mergedCount = 0;
  const LABEL_MARGIN = 2000;
  const ANGLE_TOLERANCE = 15;
  const LEADER_PROXIMITY = 1200;

  const normalizeAngle = (deg: number) => {
    let a = deg % 360;
    if (a < 0) a += 360;
    return a;
  };

  const isHorizontalAngle = (deg: number) => {
    const a = normalizeAngle(deg) % 180;
    return a <= ANGLE_TOLERANCE || a >= 180 - ANGLE_TOLERANCE;
  };

  const isVerticalAngle = (deg: number) => {
    const a = normalizeAngle(deg) % 180;
    return Math.abs(a - 90) <= ANGLE_TOLERANCE;
  };

  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

  const distancePointToSegment = (p: Point, a: Point, b: Point) => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const abLenSq = abx * abx + aby * aby;
    if (abLenSq === 0) return dist(p, a);
    let t = (apx * abx + apy * aby) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: a.x + abx * t, y: a.y + aby * t };
    return dist(p, proj);
  };

  const layerLooksLabel = (layer: string) => {
    const labelLayers = project.layerConfig[SemanticLayer.BEAM_LABEL];
    if (labelLayers.length > 0) return labelLayers.includes(layer);

    const u = layer.toUpperCase();
    if (u.includes('AXIS') || u.includes('中心线')) return false;
    return u.includes('标注') || u.includes('DIM') || u.includes('LABEL') || /^Z[\u4e00-\u9fa5]/.test(layer);
  };

  const detectNameOrientation = (layer: string): 'H' | 'V' | null => {
    const upper = layer.toUpperCase();
    if (layer.includes('水平') || upper.includes('HORIZONTAL') || upper.includes('_H')) return 'H';
    if (layer.includes('垂直') || layer.includes('竖') || upper.includes('VERT') || upper.includes('_V')) return 'V';
    return null;
  };

  const collectLeaderSegments = (layerEntities: DxfEntity[], texts: DxfEntity[]) => {
    const segments: { start: Point; end: Point }[] = [];

    layerEntities.forEach(ent => {
      if (ent.type === EntityType.LINE && ent.start && ent.end) {
        segments.push({ start: ent.start, end: ent.end });
      } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
        for (let i = 0; i < ent.vertices.length - 1; i++) {
          const a = ent.vertices[i];
          const b = ent.vertices[i + 1];
          if (a && b) segments.push({ start: a, end: b });
        }
      }
    });

    if (segments.length === 0 || texts.length === 0) return segments;

    const nearSegments: { start: Point; end: Point }[] = [];
    texts.forEach(t => {
      if (!t.start) return;
      const threshold = (t.radius || 300) * 2 + LEADER_PROXIMITY;
      segments.forEach(seg => {
        if (distancePointToSegment(t.start!, seg.start, seg.end) <= threshold) {
          nearSegments.push(seg);
        }
      });
    });

    return nearSegments.length > 0 ? nearSegments : segments;
  };

  const detectLeaderOrientation = (segments: { start: Point; end: Point }[]): 'H' | 'V' | null => {
    let h = 0;
    let v = 0;
    segments.forEach(seg => {
      const angle = Math.abs((Math.atan2(seg.end.y - seg.start.y, seg.end.x - seg.start.x) * 180) / Math.PI);
      if (isHorizontalAngle(angle)) h++;
      else if (isVerticalAngle(angle)) v++;
    });
    if (h === 0 && v === 0) return null;
    return h >= v ? 'H' : 'V';
  };

  const detectTextOrientation = (texts: DxfEntity[]): 'H' | 'V' | null => {
    let h = 0;
    let v = 0;
    texts.forEach(t => {
      const rot = t.rotation !== undefined ? t.rotation : (t.startAngle || 0);
      const ang = normalizeAngle(rot) % 180;
      if (isHorizontalAngle(ang)) h++;
      else if (isVerticalAngle(ang)) v++;
    });
    if (h === 0 && v === 0) return null;
    return h >= v ? 'H' : 'V';
  };

  const labelLayerTargets: Record<string, string> = {};
  const entitiesByLayer: Record<string, DxfEntity[]> = {};
  allEntities.forEach(ent => {
    if (!entitiesByLayer[ent.layer]) entitiesByLayer[ent.layer] = [];
    entitiesByLayer[ent.layer].push(ent);
  });

  Object.entries(entitiesByLayer).forEach(([layer, ents]) => {
    if (!layerLooksLabel(layer)) return;
    const texts = ents.filter(e => (e.type === EntityType.TEXT || e.type === EntityType.MTEXT || e.type === EntityType.ATTRIB) && e.start);
    const nameHint = detectNameOrientation(layer);
    const leaderSegments = collectLeaderSegments(ents, texts);
    if (leaderSegments.length === 0) return;
    const leaderOrientation = detectLeaderOrientation(leaderSegments);
    const textOrientation = detectTextOrientation(texts);

    let target: string | null = null;
    if (nameHint === 'H') target = MERGE_RESULT_LAYER_H;
    else if (nameHint === 'V') target = MERGE_RESULT_LAYER_V;
    else if (leaderOrientation === 'H' && textOrientation === 'V') target = MERGE_RESULT_LAYER_V;
    else if (leaderOrientation === 'V' && textOrientation === 'H') target = MERGE_RESULT_LAYER_H;

    if (target) labelLayerTargets[layer] = target;
  });

  const pushMerged = (layer: string, ent: DxfEntity) => {
    mergedEntities.push(ent);
    if (!mergedByLayer[layer]) mergedByLayer[layer] = [];
    mergedByLayer[layer].push(ent);
  };

  const isLabelEntity = (ent: DxfEntity): boolean => {
    if (!labelLayerTargets[ent.layer]) return false;
    const u = ent.layer.toUpperCase();
    if (u.includes('AXIS') || u.includes('中心线')) return false;
    if (project.layerConfig[SemanticLayer.BEAM_LABEL].includes(ent.layer)) return true;

    const looksLabel = u.includes('标注') || u.includes('DIM') || u.includes('LABEL') || /^Z[\u4e00-\u9fa5]/.test(ent.layer);
    if (ent.type === EntityType.DIMENSION) return true;
    if (ent.type === EntityType.TEXT || ent.type === EntityType.MTEXT || ent.type === EntityType.ATTRIB) return looksLabel;
    return looksLabel;
  };

  const shouldIncludeEntity = (ent: DxfEntity, bounds: Bounds): boolean => {
    const expanded = expandBounds(bounds, LABEL_MARGIN);
    if (ent.start && isPointInBounds(ent.start, expanded)) return true;
    if (ent.type === EntityType.DIMENSION) {
      if (ent.measureStart && isPointInBounds(ent.measureStart, expanded)) return true;
      if (ent.measureEnd && isPointInBounds(ent.measureEnd, expanded)) return true;
      if (ent.end && isPointInBounds(ent.end, expanded)) return true;
    }
    const b = getEntityBounds(ent);
    if (b) {
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      if (isPointInBounds({ x: cx, y: cy }, expanded)) return true;
      if (boundsOverlap(b, expanded)) return true;
    }
    return false;
  };

  Object.entries(groups).forEach(([, views]) => {
    views.sort((a, b) => (a.info?.index ?? 1) - (b.info?.index ?? 1));
    const baseView = views[0];

    allEntities.forEach(ent => {
      const targetLayer = labelLayerTargets[ent.layer];
      if (!targetLayer) return;
      if (shouldIncludeEntity(ent, baseView.bounds) && isLabelEntity(ent)) {
        const clone = { ...ent, layer: targetLayer };
        pushMerged(targetLayer, clone);
      }
    });

    if (views.length > 1) {
      const baseIntersections = getGridIntersections(baseView.bounds, axisLines);

      for (let i = 1; i < views.length; i++) {
        const targetView = views[i];
        const targetIntersections = getGridIntersections(targetView.bounds, axisLines);

        const vec = calculateMergeVector(baseIntersections, targetIntersections);

        if (vec) {
          allEntities.forEach(ent => {
            const targetLayer = labelLayerTargets[ent.layer];
            if (!targetLayer) return;
            if (shouldIncludeEntity(ent, targetView.bounds) && isLabelEntity(ent)) {
              const clone = { ...ent, layer: targetLayer };

              if (clone.start) clone.start = { x: clone.start.x + vec.x, y: clone.start.y + vec.y };
              if (clone.end) clone.end = { x: clone.end.x + vec.x, y: clone.end.y + vec.y };
              if (clone.center) clone.center = { x: clone.center.x + vec.x, y: clone.center.y + vec.y };
              if (clone.vertices) clone.vertices = clone.vertices.map(v => ({ x: v.x + vec.x, y: v.y + vec.y }));
              if (clone.measureStart) clone.measureStart = { x: clone.measureStart.x + vec.x, y: clone.measureStart.y + vec.y };
              if (clone.measureEnd) clone.measureEnd = { x: clone.measureEnd.x + vec.x, y: clone.measureEnd.y + vec.y };

              pushMerged(targetLayer, clone);
            }
          });
          mergedCount++;
        }
      }
    }
    mergedCount++;
  });

  if (mergedEntities.length === 0) {
    return null;
  }

  const buildBeamLabelInfos = (): BeamLabelInfo[] => {
    const infos: BeamLabelInfo[] = [];
    const targetLayers = [MERGE_RESULT_LAYER_H, MERGE_RESULT_LAYER_V];

    targetLayers.forEach(layer => {
      const ents = mergedByLayer[layer] || [];
      const texts = ents.filter(e => (e.type === EntityType.TEXT || e.type === EntityType.MTEXT || e.type === EntityType.ATTRIB) && e.start);
      const leaders = ents.filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

      texts.forEach((txt, idx) => {
        if (!txt.start) return;
        const rot = txt.rotation !== undefined ? txt.rotation : (txt.startAngle || 0);
        const angNorm = normalizeAngle(rot) % 180;
        const vert = isVerticalAngle(angNorm);
        const basePoint: Point = (vert && txt.end) ? txt.end : (txt.start as Point);

        let bestSeg: { start: Point; end: Point } | null = null;
        let bestDist = Infinity;

        const considerSegment = (a: Point, b: Point) => {
          const d = distancePointToSegment(basePoint, a, b);
          if (d < bestDist) {
            bestDist = d;
            bestSeg = { start: a, end: b };
          }
        };

        leaders.forEach(l => {
          if (l.type === EntityType.LINE && l.start && l.end) {
            considerSegment(l.start, l.end);
          } else if (l.type === EntityType.LWPOLYLINE && l.vertices && l.vertices.length > 1) {
            for (let i = 0; i < l.vertices.length - 1; i++) {
              const a = l.vertices[i];
              const b = l.vertices[i + 1];
              if (a && b) considerSegment(a, b);
            }
          }
        });

        if (!bestSeg) return;
        let leaderStart = bestSeg.start;
        let leaderEnd = bestSeg.end;
        const dStart = dist(basePoint, bestSeg.start);
        const dEnd = dist(basePoint, bestSeg.end);
        if (dEnd < dStart) {
          leaderStart = bestSeg.end;
          leaderEnd = bestSeg.start;
        }
        const bestAngle = (Math.atan2(leaderEnd.y - leaderStart.y, leaderEnd.x - leaderStart.x) * 180) / Math.PI;

        const firstLine = (txt.text || '').split(/\r?\n/)[0]?.trim() || '';
        const richMatch = firstLine.match(/^([A-Z0-9\-]+)\(([^)]+)\)\s+(\d+)[xX*](\d+)/i);
        const simpleDimMatch = firstLine.match(/^([A-Z0-9\-]+)\s+(\d+)[xX*](\d+)/i);
        const codeSpanMatch = firstLine.match(/^([A-Z0-9\-]+)\(([^)]+)\)/i);
        const codeOnlyMatch = firstLine.match(/^([A-Z0-9\-]+)$/i);

        let parsed: { code: string; span: string | null; width?: number; height?: number } | undefined = undefined;
        if (richMatch) {
          parsed = {
            code: richMatch[1],
            span: richMatch[2],
            width: parseInt(richMatch[3]),
            height: parseInt(richMatch[4])
          };
        } else if (simpleDimMatch) {
          parsed = {
            code: simpleDimMatch[1],
            span: null,
            width: parseInt(simpleDimMatch[2]),
            height: parseInt(simpleDimMatch[3])
          };
        } else if (codeSpanMatch) {
          parsed = { code: codeSpanMatch[1], span: codeSpanMatch[2] };
        } else if (codeOnlyMatch) {
          parsed = { code: codeOnlyMatch[1], span: null };
        }

        infos.push({
          id: `${layer}-${idx}`,
          sourceLayer: layer,
          orientation: bestAngle,
          textRaw: txt.text || '',
          textInsert: txt.start || null,
          leaderStart,
          leaderEnd,
          parsed
        });
      });
    });

    const byCode = new Map<string, { width?: number; height?: number }>();
    infos.forEach(info => {
      const p = info.parsed;
      if (!p) return;
      if ((p.width ?? 0) > 0 && (p.height ?? 0) > 0) {
        if (!byCode.has(p.code)) byCode.set(p.code, { width: p.width, height: p.height });
      }
    });

    const needsManual: string[] = [];
    infos.forEach(info => {
      const p = info.parsed;
      if (!p) return;
      const missingDim = (p.width ?? 0) === 0 || (p.height ?? 0) === 0;
      if (missingDim) {
        const donor = byCode.get(p.code);
        if (donor && donor.width && donor.height) {
          p.width = donor.width;
          p.height = donor.height;
        } else {
          needsManual.push(info.id);
        }
      }
    });

    if (needsManual.length > 0) {
      console.warn(`Beam labels missing dimensions; please confirm manually: ${needsManual.join(', ')}`);
    }

    return infos;
  };

  const layersAdded = Object.keys(mergedByLayer);
  if (layersAdded.length === 0) {
    return null;
  }

  const beamLabels = buildBeamLabelInfos();
  const layersAddedSet = new Set(layersAdded);
  const mergedLayerList = [
    ...layersAdded,
    ...project.data.layers.filter(l => !layersAddedSet.has(l))
  ];

  const updatedData: DxfData = {
    ...project.data,
    entities: [...project.data.entities, ...mergedEntities],
    layers: mergedLayerList
  };

  return { updatedData, layersAdded, beamLabels, mergedCount };
};
