import { ProjectFile, DxfEntity, EntityType, Point, Bounds, BeamStep3AttrInfo } from '../../../types';
import { isPointInBounds } from '../common';
import { getEntityBounds, distance, getCenter } from '../../../utils/geometryUtils';
import { extractEntities } from '../../../utils/dxfHelpers';
import { collectBeamSources, computeOBB, OBB } from './common';

export interface BeamAttributeResult {
  resultLayer: string;
  debugLayer: string;
  entities: DxfEntity[];
  infos: BeamStep3AttrInfo[];
  contextLayers: string[];
  colors: Record<string, string>;
  message: string;
}

/**
 * Pure calculation for Step 3: Mount Attributes (no React/state).
 */
export const calculateBeamAttributeMounting = (
  activeProject: ProjectFile,
  projects: ProjectFile[]
): BeamAttributeResult | null => {
  const sourceLayer = 'BEAM_STEP2_GEO';
  const resultLayer = 'BEAM_STEP3_ATTR';
  const debugLayer = 'BEAM_STEP3_TARGET_DEBUG';
  const beamLabels = activeProject.beamLabels || [];
  const sources = collectBeamSources(activeProject, projects);
  if (!sources) return null;
  const obstacleBounds = sources.obstacles.map(o => getEntityBounds(o)).filter((b): b is Bounds => !!b);

  const beams = extractEntities([sourceLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
    .filter(e => e.type !== EntityType.TEXT && e.type !== EntityType.MTEXT);
  if (beams.length === 0) {
    return null;
  }

  const attrBeams = JSON.parse(JSON.stringify(beams)) as DxfEntity[];
  attrBeams.forEach(b => b.layer = resultLayer);
  const debugMarks: DxfEntity[] = [];

  const beamObbs = attrBeams
    .map((b, i) => ({ obb: computeOBB(b), index: i, attr: null as BeamAttributes | null, label: null as DxfEntity | null }))
    .filter(b => b.obb !== null);

  const isPointInOBB = (pt: Point, obb: OBB): boolean => {
    const dx = pt.x - obb.center.x;
    const dy = pt.y - obb.center.y;
    const du = dx * obb.u.x + dy * obb.u.y;
    const dv = dx * -obb.u.y + dy * obb.u.x;
    return Math.abs(du) <= obb.halfLen + 20 && Math.abs(dv) <= obb.halfWidth + 20;
  };

  const findBeamForPoint = (pt: Point | null): typeof beamObbs[number] | null => {
    if (!pt) return null;
    return beamObbs.find(item => {
      const obb = item.obb!;
      return isPointInOBB(pt, obb);
    }) || null;
  };

  const isPointCovered = (pt: Point): boolean => {
    if (beamObbs.some(b => b.obb && isPointInOBB(pt, b.obb))) return true;
    return obstacleBounds.some(b => isPointInBounds(pt, b));
  };

  const geoInfoByIndex = new Map<number, string>();
  (activeProject.beamStep2GeoInfos || []).forEach(info => geoInfoByIndex.set(info.beamIndex, info.id));

  const isConnectedAlongAxis = (a: typeof beamObbs[number], b: typeof beamObbs[number]): boolean => {
    if (!a.obb || !b.obb) return false;
    const endA1 = { x: a.obb.center.x + a.obb.u.x * a.obb.maxT, y: a.obb.center.y + a.obb.u.y * a.obb.maxT };
    const endA2 = { x: a.obb.center.x + a.obb.u.x * a.obb.minT, y: a.obb.center.y + a.obb.u.y * a.obb.minT };
    const endB1 = { x: b.obb.center.x + b.obb.u.x * b.obb.maxT, y: b.obb.center.y + b.obb.u.y * b.obb.maxT };
    const endB2 = { x: b.obb.center.x + b.obb.u.x * b.obb.minT, y: b.obb.center.y + b.obb.u.y * b.obb.minT };

    const pair1 = distance(endA1, endB2);
    const pair2 = distance(endA2, endB1);
    const [pA, pB] = pair1 <= pair2 ? [endA1, endB2] : [endA2, endB1];

    const totalDist = distance(pA, pB);
    const steps = Math.max(5, Math.ceil(totalDist / 50));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const pt = { x: pA.x + (pB.x - pA.x) * t, y: pA.y + (pB.y - pA.y) * t };
      const covered = isPointCovered(pt);
      if (!covered) {
        return false;
      }
    }
    return true;
  };

  const markDebug = (pt: Point | null, text: string, angle?: number | null) => {
    if (!pt) return;
    debugMarks.push({
      type: EntityType.TEXT,
      layer: debugLayer,
      start: pt,
      text,
      radius: 120,
      startAngle: angle ?? 0
    });
  };

  let matchCount = 0;

  beamLabels.forEach(lbl => {
    const leaderAnchor = lbl.leaderStart;
    const leaderArrow = lbl.leaderEnd;

    if (!leaderAnchor || !leaderArrow) return;
    if (distance(leaderAnchor, leaderArrow) < 1e-3) {
      markDebug(leaderAnchor, 'A=B invalid leader');
      return;
    }

    const anchorBeam = findBeamForPoint(leaderAnchor);
    const arrowBeam = findBeamForPoint(leaderArrow);
    const conflict = anchorBeam && arrowBeam && anchorBeam.index !== arrowBeam.index;

    const hitBeam = conflict ? null : (anchorBeam || arrowBeam);

    if (conflict) {
      return null;
    }

    if (hitBeam && lbl.parsed) {
      hitBeam.attr = {
        code: lbl.parsed.code,
        span: lbl.parsed.span,
        width: lbl.parsed.width ?? 0,
        height: lbl.parsed.height ?? 0,
        rawLabel: lbl.textRaw,
        fromLabel: true
      };
      const spanText = lbl.parsed.span ? `(${lbl.parsed.span})` : '';
      markDebug(leaderArrow, `${lbl.parsed.code}${spanText}`, lbl.orientation);
      matchCount++;
    }
    return null;
  });

  const sortedBeams = [...beamObbs].sort((a, b) => {
    const angA = Math.atan2(a.obb!.u.y, a.obb!.u.x);
    const angB = Math.atan2(b.obb!.u.y, b.obb!.u.x);
    if (Math.abs(angA - angB) > 0.1) return angA - angB;

    const distA = a.obb!.center.x * -a.obb!.u.y + a.obb!.center.y * a.obb!.u.x;
    const distB = b.obb!.center.x * -b.obb!.u.y + b.obb!.center.y * b.obb!.u.x;
    return distA - distB;
  });

  let i = 0;
  while (i < sortedBeams.length) {
    let j = i + 1;
    const group = [sortedBeams[i]];
    const base = sortedBeams[i];

    while (j < sortedBeams.length) {
      const curr = sortedBeams[j];
      const dot = Math.abs(base.obb!.u.x * curr.obb!.u.x + base.obb!.u.y * curr.obb!.u.y);
      if (dot < 0.98) break;

      const perpDistA = base.obb!.center.x * -base.obb!.u.y + base.obb!.center.y * base.obb!.u.x;
      const perpDistB = curr.obb!.center.x * -curr.obb!.u.y + curr.obb!.center.y * curr.obb!.u.x;

      if (Math.abs(perpDistA - perpDistB) > 200) break;

      const connected = isConnectedAlongAxis(base, curr);
      if (connected) {
        group.push(curr);
      }
      j++;
    }

    const definedAttrs = group.filter(b => b.attr !== null && b.attr.fromLabel).map(b => b.attr!);

    if (definedAttrs.length > 0) {
      const primaryAttr = definedAttrs[0];

      group.forEach(b => {
        if (!b.attr) {
          b.attr = { ...primaryAttr, fromLabel: false };
        }
      });
    }

    i++;
  }

  const firstKnown = beamLabels.find(lbl => lbl.parsed && lbl.parsed.width && lbl.parsed.height);
  const fallbackWidth = firstKnown?.parsed?.width || 300;
  const fallbackHeight = firstKnown?.parsed?.height || 600;

  const attrInfos: BeamStep3AttrInfo[] = beamObbs.map((b, idx) => {
    const obb = b.obb!;
    const bnds = {
      startX: obb.center.x + obb.u.x * obb.minT + -obb.u.y * obb.halfWidth,
      startY: obb.center.y + obb.u.y * obb.minT + obb.u.x * obb.halfWidth,
      endX: obb.center.x + obb.u.x * obb.maxT + obb.u.y * obb.halfWidth,
      endY: obb.center.y + obb.u.y * obb.maxT - obb.u.x * obb.halfWidth
    };
    const attr = b.attr || {
      code: 'UNKNOWN',
      span: null,
      width: fallbackWidth,
      height: fallbackHeight,
      rawLabel: 'N/A',
      fromLabel: false
    };

    const name = attr.code || 'UNKNOWN';

    return {
      id: geoInfoByIndex.get(idx) || `ATTR-${idx}`,
      layer: resultLayer,
      shape: 'rect',
      vertices: [
        { x: bnds.startX, y: bnds.startY },
        { x: bnds.endX, y: bnds.startY },
        { x: bnds.endX, y: bnds.endY },
        { x: bnds.startX, y: bnds.endY }
      ],
      bounds: { startX: Math.min(bnds.startX, bnds.endX), startY: Math.min(bnds.startY, bnds.endY), endX: Math.max(bnds.startX, bnds.endX), endY: Math.max(bnds.startY, bnds.endY) },
      center: obb.center,
      radius: undefined,
      angle: Math.atan2(obb.u.y, obb.u.x) * 180 / Math.PI,
      beamIndex: b.index,
      code: name,
      span: attr.span,
      width: attr.width,
      height: attr.height,
      rawLabel: attr.rawLabel
    };
  });

  // Add visible labels on the result layer for debugging/inspection
  const labelEntities: DxfEntity[] = attrInfos.map((info, idx) => ({
    type: EntityType.TEXT,
    layer: resultLayer,
    start: info.center || info.vertices[0],
    text: `${info.id} ${info.code}`,
    radius: 180,
    startAngle: info.angle || 0
  }));

  const entities: DxfEntity[] = [...attrBeams, ...debugMarks, ...labelEntities];
  const colors: Record<string, string> = {
    [resultLayer]: '#f59e0b',
    [debugLayer]: '#8b5cf6'
  };

  const message = `Step 3: Mounted attributes on ${attrInfos.length} beams (matched ${matchCount}).`;

  return {
    resultLayer,
    debugLayer,
    entities,
    infos: attrInfos,
    contextLayers: ['AXIS', 'COLU_CALC', 'WALL_CALC'],
    colors,
    message
  };
};

interface BeamAttributes {
  code: string;
  span?: string | null;
  width: number;
  height: number;
  rawLabel: string;
  fromLabel: boolean;
}
