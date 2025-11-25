import { DxfEntity, EntityType, Point, Bounds } from '../types';

export const distance = (p1: Point, p2: Point): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
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
    // Basic point check for single point entities to avoid infinite bounds
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
                 // Calculate angle in degrees
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

/**
 * Transforms a point based on standard DXF Insert logic:
 * P_world = RotationMatrix * (Scale * P_local) + Translation
 */
export const transformPoint = (p: Point, scale: Point, rotationDeg: number, translation: Point): Point => {
  // 1. Scale
  const sx = p.x * (scale.x || 1);
  const sy = p.y * (scale.y || 1);

  // 2. Rotate
  const rad = rotationDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  
  const rx = sx * cos - sy * sin;
  const ry = sx * sin + sy * cos;

  // 3. Translate
  return {
    x: rx + translation.x,
    y: ry + translation.y
  };
};
