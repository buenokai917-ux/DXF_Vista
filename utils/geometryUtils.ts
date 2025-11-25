import { DxfEntity, EntityType, Point, Bounds } from '../types';

export const distance = (p1: Point, p2: Point): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

export const distancePointToLine = (p: Point, lStart: Point, lEnd: Point): number => {
  const A = p.x - lStart.x;
  const B = p.y - lStart.y;
  const C = lEnd.x - lStart.x;
  const D = lEnd.y - lStart.y;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  if (lenSq !== 0) param = dot / lenSq;

  let xx, yy;

  if (param < 0) {
    xx = lStart.x;
    yy = lStart.y;
  } else if (param > 1) {
    xx = lEnd.x;
    yy = lEnd.y;
  } else {
    xx = lStart.x + param * C;
    yy = lStart.y + param * D;
  }

  const dx = p.x - xx;
  const dy = p.y - yy;
  return Math.sqrt(dx * dx + dy * dy);
};

export const getEntityBounds = (entity: DxfEntity): Bounds | null => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const update = (p: Point) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };

  if (entity.type === EntityType.LINE && entity.start && entity.end) {
    update(entity.start);
    update(entity.end);
  } else if (entity.type === EntityType.LWPOLYLINE && entity.vertices) {
    entity.vertices.forEach(update);
  } else if ((entity.type === EntityType.CIRCLE || entity.type === EntityType.ARC) && entity.center && entity.radius) {
    update({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
    update({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
  } else if ((entity.type === EntityType.TEXT || entity.type === EntityType.INSERT) && entity.start) {
    update(entity.start);
  } else {
    return null;
  }

  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
};

export const getCenter = (entity: DxfEntity): Point | null => {
  if (entity.type === EntityType.LINE && entity.start && entity.end) {
    return {
      x: (entity.start.x + entity.end.x) / 2,
      y: (entity.start.y + entity.end.y) / 2
    };
  }
  
  const bounds = getEntityBounds(entity);
  if (bounds) {
    return {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2
    };
  }

  return entity.center || entity.start || null;
};

// Returns beam properties: length and angle (in degrees)
export const getBeamProperties = (entity: DxfEntity): { length: number, angle: number } => {
  if (entity.type === EntityType.LWPOLYLINE && entity.vertices && entity.vertices.length > 0) {
      if (entity.closed) {
         // Find the longest segment to determine length and orientation
         let maxLen = 0;
         let angle = 0;
         const verts = entity.vertices;
         const count = verts.length;
         
         for(let i=0; i<count; i++) {
             const p1 = verts[i];
             const p2 = verts[(i+1) % count];
             const d = distance(p1, p2);
             if (d > maxLen) {
                 maxLen = d;
                 angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
             }
         }
         return { length: maxLen, angle };
      }
  }
  return { length: calculateLength(entity), angle: 0 };
};

export const calculateLength = (entity: DxfEntity): number => {
  switch (entity.type) {
    case EntityType.LINE:
      if (entity.start && entity.end) {
        return distance(entity.start, entity.end);
      }
      return 0;

    case EntityType.LWPOLYLINE:
      if (entity.vertices && entity.vertices.length > 1) {
        if (entity.closed) {
           const props = getBeamProperties(entity);
           return props.length;
        }

        let len = 0;
        for (let i = 0; i < entity.vertices.length - 1; i++) {
          len += distance(entity.vertices[i], entity.vertices[i + 1]);
        }
        return len;
      }
      return 0;

    case EntityType.CIRCLE:
      if (entity.radius) return 2 * Math.PI * entity.radius;
      return 0;

    case EntityType.ARC:
      if (entity.radius && entity.startAngle !== undefined && entity.endAngle !== undefined) {
        let diff = entity.endAngle - entity.startAngle;
        if (diff < 0) diff += 360;
        return (diff * Math.PI / 180) * entity.radius;
      }
      return 0;

    default:
      return 0;
  }
};

export const transformPoint = (p: Point, scale: Point, rotationDeg: number, translation: Point): Point => {
  const sx = p.x * (scale.x || 1);
  const sy = p.y * (scale.y || 1);

  const rad = rotationDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  
  const rx = sx * cos - sy * sin;
  const ry = sx * sin + sy * cos;

  return {
    x: rx + translation.x,
    y: ry + translation.y
  };
};

// Reconstructs parallel lines into closed polygons (walls/beams)
// Tolerance is max width (e.g. 600mm for walls, 1200mm for beams)
export const findParallelPolygons = (lines: DxfEntity[], tolerance = 600, resultLayer = 'CALC_LAYER'): DxfEntity[] => {
  const polygons: DxfEntity[] = [];
  const used = new Set<number>(); 

  // Sort lines by length descending to process main segments first
  const sortedLines = lines.map((l, i) => ({ l, i, len: calculateLength(l) })).sort((a, b) => b.len - a.len);

  for (let idxA = 0; idxA < sortedLines.length; idxA++) {
    const { l: l1, i: i, len: len1 } = sortedLines[idxA];
    if (used.has(i)) continue;
    if (l1.type !== EntityType.LINE || !l1.start || !l1.end) continue;
    if (len1 < 50) continue; // Ignore tiny lines

    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    
    let bestMatchIdx = -1;
    let minPerpDist = Infinity;

    for (let idxB = idxA + 1; idxB < sortedLines.length; idxB++) {
       const { l: l2, i: j, len: len2 } = sortedLines[idxB];
       if (used.has(j)) continue;
       if (l2.type !== EntityType.LINE || !l2.start || !l2.end) continue;

       // 1. Length Similarity (allow 30% diff)
       if (Math.abs(len1 - len2) > Math.max(len1, len2) * 0.3) continue;

       const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
       
       // 2. Parallel Check
       // Dot product of normalized vectors should be ~1 or ~-1
       const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
       if (Math.abs(dot) < 0.98) continue; // Not parallel

       // 3. Proximity Check
       // Check distance of l2 center to l1 infinite line
       const l2Center = { x: (l2.start.x + l2.end.x)/2, y: (l2.start.y + l2.end.y)/2 };
       const dist = distancePointToLine(l2Center, l1.start, l1.end);

       if (dist > tolerance || dist < 10) continue; // Too far or coincident

       // 4. Overlap Check (Project onto l1 direction)
       const centerDist = distance(getCenter(l1)!, l2Center);
       if (centerDist > len1 * 0.6 + tolerance) continue; // Centers too far apart longitudinally

       if (dist < minPerpDist) {
           minPerpDist = dist;
           bestMatchIdx = j;
       }
    }

    if (bestMatchIdx !== -1) {
        used.add(i);
        used.add(bestMatchIdx);
        
        const l2 = lines.find((_, idx) => idx === bestMatchIdx);
        if (l2) {
             polygons.push(createPolygonFromPair(l1, l2, resultLayer));
        }
    }
  }
  return polygons;
};

const createPolygonFromPair = (l1: DxfEntity, l2: DxfEntity, layer: string): DxfEntity => {
    // Determine winding order to create a nice rectangle
    if (!l1.start || !l1.end || !l2.start || !l2.end) return l1;

    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
    
    const dot = v1.x * v2.x + v1.y * v2.y;
    
    let vertices: Point[];
    
    // If dot > 0, lines run same direction. 
    // Poly: Start1 -> End1 -> End2 -> Start2
    if (dot > 0) {
        vertices = [l1.start, l1.end, l2.end, l2.start];
    } else {
        // Anti-parallel
        // Poly: Start1 -> End1 -> Start2 -> End2
        vertices = [l1.start, l1.end, l2.start, l2.end];
    }

    return {
        type: EntityType.LWPOLYLINE,
        layer: layer,
        vertices: vertices,
        closed: true
    };
};
