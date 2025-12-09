import { ProjectFile, DxfEntity, EntityType, BeamStep3AttrInfo, BeamStep4TopologyInfo, Bounds, BeamIntersectionInfo } from '../../../types';
import { getEntityBounds } from '../../../utils/geometryUtils';
import { computeOBB, OBB } from './common';

export interface BeamTopologyResult {
  resultLayer: string;
  entities: DxfEntity[];
  infos: BeamStep4TopologyInfo[];
  colors: Record<string, string>;
  contextLayers: string[];
  layersToHide: string[];
  extraLayers?: { layer: string; entities: DxfEntity[] }[];
  message: string;
}

interface Fragment {
  id: string;               // e.g., "F-1", "F-1-A"
  sourceIndex: number;      // Link back to Step 3 info
  poly: DxfEntity;
  obb: OBB;
  attr: {
    code: string;
    span: number;
    width: number;
    height: number;
    priority: number;       // 2 (High), 1 (Low), 0 (Unknown)
  };
  dirty: boolean;
}

interface ActiveIntersection {
  info: BeamIntersectionInfo;
  resolved: boolean;
}

const parseSpan = (spanStr?: string | null): number => {
  if (!spanStr) return 1;
  const match = spanStr.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
};

const getCodePriority = (code?: string): number => {
  if (!code) return 0;
  const c = code.toUpperCase();
  if (/^(WKL|KL|LL|XL)/.test(c)) return 2;
  if (c.startsWith('L')) return 1;
  return 0;
};

const fragmentOverlaps = (frag: Fragment, box: Bounds): boolean => {
  const obb = frag.obb;
  const center = obb.center;
  const fBounds = getEntityBounds(frag.poly);
  if (!fBounds) return false;

  if (fBounds.maxX < box.minX || fBounds.minX > box.maxX ||
    fBounds.maxY < box.minY || fBounds.minY > box.maxY) return false;

  const boxPts = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }
  ];

  let minU = Infinity, maxU = -Infinity;
  let minV = Infinity, maxV = -Infinity;

  boxPts.forEach(p => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const uVal = dx * obb.u.x + dy * obb.u.y;
    const vVal = dx * obb.v.x + dy * obb.v.y;

    minU = Math.min(minU, uVal);
    maxU = Math.max(maxU, uVal);
    minV = Math.min(minV, vVal);
    maxV = Math.max(maxV, vVal);
  });

  if (maxU < obb.minT || minU > obb.maxT) return false;
  if (maxV < -obb.halfWidth || minV > obb.halfWidth) return false;

  return true;
};

const cutFragment = (frag: Fragment, box: Bounds): Fragment[] => {
  const obb = frag.obb;
  const center = obb.center;

  const boxPts = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }
  ];

  let tMin = Infinity;
  let tMax = -Infinity;

  boxPts.forEach(p => {
    const t = (p.x - center.x) * obb.u.x + (p.y - center.y) * obb.u.y;
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  });

  const EPS = 0;
  tMin -= EPS;
  tMax += EPS;

  const bStart = obb.minT;
  const bEnd = obb.maxT;

  const oStart = Math.max(bStart, tMin);
  const oEnd = Math.min(bEnd, tMax);

  if (oStart >= oEnd) return [frag];

  const results: Fragment[] = [];
  const makeFrag = (start: number, end: number, suffix: string): Fragment | null => {
    if (end - start < 50) return null;

    const midT = (start + end) / 2;
    const halfL = (end - start) / 2;
    const newCenter = {
      x: center.x + obb.u.x * midT,
      y: center.y + obb.u.y * midT
    };

    const p1 = { x: newCenter.x + obb.u.x * halfL + obb.v.x * obb.halfWidth, y: newCenter.y + obb.u.y * halfL + obb.v.y * obb.halfWidth };
    const p2 = { x: newCenter.x + obb.u.x * halfL - obb.v.x * obb.halfWidth, y: newCenter.y + obb.u.y * halfL - obb.v.y * obb.halfWidth };
    const p3 = { x: newCenter.x - obb.u.x * halfL - obb.v.x * obb.halfWidth, y: newCenter.y - obb.u.y * halfL - obb.v.y * obb.halfWidth };
    const p4 = { x: newCenter.x - obb.u.x * halfL + obb.v.x * obb.halfWidth, y: newCenter.y - obb.u.y * halfL + obb.v.y * obb.halfWidth };

    const newPoly: DxfEntity = {
      type: EntityType.LWPOLYLINE,
      layer: frag.poly.layer,
      closed: true,
      vertices: [p1, p2, p3, p4]
    };

    const newObb = computeOBB(newPoly);
    if (!newObb) return null;

    return {
      ...frag,
      id: frag.id + suffix,
      poly: newPoly,
      obb: newObb,
      dirty: false
    };
  };

  if (oStart > bStart + 10 && oEnd < bEnd - 10) {
    const f1 = makeFrag(bStart, oStart, "-A");
    const f2 = makeFrag(oEnd, bEnd, "-B");
    if (f1) results.push(f1);
    if (f2) results.push(f2);
  } else if (oStart <= bStart + 10 && oEnd < bEnd - 10) {
    const f1 = makeFrag(oEnd, bEnd, "-T");
    if (f1) results.push(f1);
  } else if (oStart > bStart + 10 && oEnd >= bEnd - 10) {
    const f1 = makeFrag(bStart, oStart, "-H");
    if (f1) results.push(f1);
  } else {
    // total consume -> drop
  }

  return results;
};

export const calculateBeamTopologyMerge = (
  activeProject: ProjectFile,
  projects: ProjectFile[]
): BeamTopologyResult | null => {
  const prevLayers = ['BEAM_STEP3_ATTR', 'BEAM_STEP2_INTER_SECTION'];
  const resultLayer = 'BEAM_STEP4_LOGIC';
  const errorLayer = 'BEAM_STEP4_ERRORS';

  const infos = activeProject.beamStep3AttrInfos;
  const inters = activeProject.beamStep2InterInfos;

  if (!infos || infos.length === 0 || !inters || inters.length === 0) {
    return null;
  }

  let fragments: Fragment[] = [];
  const unknownCodeFrags: Fragment[] = [];

  infos.forEach((info, idx) => {
    if (!info.vertices || info.vertices.length < 4) return;
    const poly: DxfEntity = { type: EntityType.LWPOLYLINE, vertices: info.vertices, closed: true, layer: 'TEMP' };
    const obb = computeOBB(poly);
    if (!obb) return;

    const f: Fragment = {
      id: `F-${idx}`,
      sourceIndex: info.beamIndex,
      poly: poly,
      obb: obb,
      attr: {
        code: info.code || '',
        span: parseSpan(info.span),
        width: info.width || 0,
        height: info.height || 0,
        priority: getCodePriority(info.code)
      },
      dirty: false
    };

    if (!info.code) {
      unknownCodeFrags.push(f);
    }
    fragments.push(f);
  });

  const intersections: ActiveIntersection[] = inters.map(i => ({
    info: i,
    resolved: false
  }));

  const invalidCrossErrors: ActiveIntersection[] = [];

  const processIntersections = (
    filterFn: (inter: ActiveIntersection, frags: Fragment[]) => { cutIds: string[]; resolved: boolean }
  ) => {
    intersections.forEach(inter => {
      if (inter.resolved) return;
      const box: Bounds = {
        minX: inter.info.bounds.startX,
        minY: inter.info.bounds.startY,
        maxX: inter.info.bounds.endX,
        maxY: inter.info.bounds.endY
      };

      const activeFrags = fragments.filter(f => fragmentOverlaps(f, box));

      if (activeFrags.length < 2) {
        inter.resolved = true;
        return;
      }

      const res = filterFn(inter, activeFrags);

      if (res.cutIds.length > 0) {
        const newFragments: Fragment[] = [];
        const idsToRemove = new Set(res.cutIds);

        const kept = fragments.filter(f => !idsToRemove.has(f.id));
        newFragments.push(...kept);

        res.cutIds.forEach(id => {
          const victim = fragments.find(f => f.id === id);
          if (victim) {
            const parts = cutFragment(victim, box);
            newFragments.push(...parts);
          }
        });

        fragments = newFragments;
      }

      if (res.resolved) {
        inter.resolved = true;
      }
    });
  };

  // PASS 1: T & C rules (span logic)
  processIntersections((inter, frags) => {
    const cutIds: string[] = [];
    let resolved = false;

    if (inter.info.junction === 'T') {
      const tAngle = inter.info.angle || 0;
      const isHeadHorizontal = (Math.abs(tAngle) < 10 || Math.abs(tAngle - 180) < 10);

      const headFrags: Fragment[] = [];
      const stemFrags: Fragment[] = [];

      frags.forEach(f => {
        const fAng = (Math.atan2(f.obb.u.y, f.obb.u.x) * 180 / Math.PI);
        const normAng = Math.abs(fAng) % 180;
        const isFragH = normAng < 45 || normAng > 135;

        if (isHeadHorizontal) {
          if (isFragH) headFrags.push(f);
          else stemFrags.push(f);
        } else {
          if (!isFragH) headFrags.push(f);
          else stemFrags.push(f);
        }
      });

      const headIsSpan1 = headFrags.some(h => h.attr.span === 1);

      if (headIsSpan1) {
        stemFrags.forEach(s => cutIds.push(s.id));
        resolved = true;
      } else {
        resolved = false;
      }
    } else if (inter.info.junction === 'C') {
      const span1Frags = frags.filter(f => f.attr.span === 1);
      const otherFrags = frags.filter(f => f.attr.span !== 1);

      if (span1Frags.length > 0 && otherFrags.length > 0) {
        otherFrags.forEach(f => cutIds.push(f.id));
        resolved = true;
      } else if (span1Frags.length > 0 && otherFrags.length === 0) {
        invalidCrossErrors.push(inter);
        resolved = true;
      } else {
        resolved = false;
      }
    }

    return { cutIds, resolved };
  });

  // PASS 2: Width diff
  processIntersections((inter, frags) => {
    frags.sort((a, b) => b.attr.width - a.attr.width);
    const maxW = frags[0].attr.width;

    const cutIds: string[] = [];
    for (let i = 1; i < frags.length; i++) {
      if (maxW - frags[i].attr.width > 10) {
        cutIds.push(frags[i].id);
      }
    }
    const remaining = frags.length - cutIds.length;
    return { cutIds, resolved: remaining === 1 };
  });

  // PASS 3: Height diff
  processIntersections((inter, frags) => {
    frags.sort((a, b) => b.attr.height - a.attr.height);
    const maxH = frags[0].attr.height;

    const cutIds: string[] = [];
    for (let i = 1; i < frags.length; i++) {
      if (maxH - frags[i].attr.height > 10) {
        cutIds.push(frags[i].id);
      }
    }
    const remaining = frags.length - cutIds.length;
    return { cutIds, resolved: remaining === 1 };
  });

  // PASS 4: Code priority
  processIntersections((inter, frags) => {
    const maxP = Math.max(...frags.map(f => f.attr.priority));
    const cutIds: string[] = [];

    frags.forEach(f => {
      if (f.attr.priority < maxP) {
        cutIds.push(f.id);
      }
    });

    const remaining = frags.length - cutIds.length;
    return { cutIds, resolved: remaining === 1 };
  });

  // PASS 5: Strong span (iterative)
  for (let attempt = 0; attempt < 3; attempt++) {
    const counts = new Map<string, number>();
    fragments.forEach(f => {
      if (f.attr.code) {
        counts.set(f.attr.code, (counts.get(f.attr.code) || 0) + 1);
      }
    });

    let changedAny = false;

    processIntersections((inter, frags) => {
      if (inter.resolved) return { cutIds: [], resolved: true };
      if (frags.length < 2) return { cutIds: [], resolved: true };

      const cutIds: string[] = [];

      const satisfied = frags.filter(f => {
        const currentCount = counts.get(f.attr.code) || 0;
        return currentCount >= f.attr.span;
      });

      if (satisfied.length > 0 && satisfied.length < frags.length) {
        const satisfiedIds = new Set(satisfied.map(f => f.id));
        frags.forEach(f => {
          if (!satisfiedIds.has(f.id)) {
            cutIds.push(f.id);
          }
        });
        if (cutIds.length > 0) changedAny = true;
        return { cutIds, resolved: true };
      }

      if (satisfied.length === frags.length) {
        if (inter.info.junction === 'T') {
          const tAngle = inter.info.angle || 0;
          const isHeadHorizontal = (Math.abs(tAngle) < 10 || Math.abs(tAngle - 180) < 10);

          const stemFrags: Fragment[] = [];

          frags.forEach(f => {
            const fAng = (Math.atan2(f.obb.u.y, f.obb.u.x) * 180 / Math.PI);
            const normAng = Math.abs(fAng) % 180;
            const isFragH = normAng < 45 || normAng > 135;

            if (isHeadHorizontal) {
              if (!isFragH) stemFrags.push(f);
            } else {
              if (isFragH) stemFrags.push(f);
            }
          });

          if (stemFrags.length > 0) {
            stemFrags.forEach(s => cutIds.push(s.id));
            changedAny = true;
            return { cutIds, resolved: true };
          }
        }
      }

      return { cutIds, resolved: false };
    });

    if (!changedAny) break;
  }

  // OUTPUT
  const resultEntities: DxfEntity[] = [];
  const labels: DxfEntity[] = [];
  const topoInfos: BeamStep4TopologyInfo[] = [];
  let fragmentCounter = 0;

  fragments.forEach(f => {
    fragmentCounter++;
    const newIdx = fragmentCounter;

    const newEnt: DxfEntity = {
      ...f.poly,
      layer: resultLayer
    };
    resultEntities.push(newEnt);

    const center = f.obb.center;
    const angleDeg = Math.atan2(f.obb.u.y, f.obb.u.x) * 180 / Math.PI;
    let finalAngle = angleDeg;
    if (finalAngle > 90 || finalAngle < -90) finalAngle += 180;
    if (finalAngle > 180) finalAngle -= 360;

    const len = Math.round(f.obb.halfLen * 2);
    const labelText = `${newIdx} ${f.attr.code || '?'}\n${len}x${f.attr.width}x${f.attr.height}`;

    labels.push({
      type: EntityType.TEXT,
      layer: resultLayer,
      text: labelText,
      start: center,
      radius: 150,
      startAngle: finalAngle
    });

    const b = getEntityBounds(newEnt);
    topoInfos.push({
      id: `TOPO-${newIdx}`,
      layer: resultLayer,
      shape: 'rect',
      vertices: newEnt.vertices || [],
      bounds: b ? { startX: b.minX, startY: b.minY, endX: b.maxX, endY: b.maxY } : { startX: 0, startY: 0, endX: 0, endY: 0 },
      center: center,
      angle: angleDeg,
      beamIndex: newIdx,
      parentBeamIndex: f.sourceIndex,
      code: f.attr.code,
      span: f.attr.span > 1 ? `(${f.attr.span})` : null,
      width: f.attr.width,
      height: f.attr.height,
      rawLabel: '',
      length: len,
      volume: len * f.attr.width * f.attr.height
    });
  });

  const errorMarkers: DxfEntity[] = [];
  unknownCodeFrags.forEach(f => {
    errorMarkers.push({
      type: EntityType.CIRCLE,
      layer: errorLayer,
      center: f.obb.center,
      radius: 300
    });
    errorMarkers.push({
      type: EntityType.TEXT,
      layer: errorLayer,
      text: "UNK",
      start: f.obb.center,
      radius: 150,
      startAngle: 0
    });
  });

  invalidCrossErrors.forEach(i => {
    const cx = (i.info.bounds.startX + i.info.bounds.endX) / 2;
    const cy = (i.info.bounds.startY + i.info.bounds.endY) / 2;
    errorMarkers.push({
      type: EntityType.LWPOLYLINE,
      layer: errorLayer,
      closed: true,
      vertices: i.info.vertices
    });
    errorMarkers.push({
      type: EntityType.TEXT,
      layer: errorLayer,
      text: "ERR-SPAN1",
      start: { x: cx, y: cy },
      radius: 150
    });
  });

  intersections.filter(i => !i.resolved).forEach(i => {
    const cx = (i.info.bounds.startX + i.info.bounds.endX) / 2;
    const cy = (i.info.bounds.startY + i.info.bounds.endY) / 2;
    errorMarkers.push({
      type: EntityType.LWPOLYLINE,
      layer: errorLayer,
      closed: true,
      vertices: i.info.vertices
    });
    errorMarkers.push({
      type: EntityType.TEXT,
      layer: errorLayer,
      text: "CHK",
      start: { x: cx, y: cy },
      radius: 150
    });
  });

  const colors: Record<string, string> = {
    [resultLayer]: '#ec4899',
    [errorLayer]: '#ef4444'
  };

  const message = `Step 4 Complete. Fragments: ${fragments.length}. Unresolved: ${intersections.filter(i => !i.resolved).length}. CrossErrors: ${invalidCrossErrors.length}. Unknowns: ${unknownCodeFrags.length}`;

  return {
    resultLayer,
    entities: [...resultEntities, ...labels, ...errorMarkers],
    infos: topoInfos,
    colors,
    contextLayers: ['AXIS', 'COLU_CALC'],
    layersToHide: prevLayers,
    extraLayers: errorMarkers.length > 0 ? [{ layer: errorLayer, entities: errorMarkers }] : undefined,
    message
  };
};
