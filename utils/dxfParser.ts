import { DxfData, DxfEntity, EntityType, Point } from '../types';

/**
 * Helper to decode DXF string format.
 * Handles \U+XXXX unicode escapes and standard symbols like %%d.
 */
const decodeDxfString = (str: string): string => {
  return str
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\M\+1([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%%c/gi, 'ø')
    .replace(/%%d/gi, '°')
    .replace(/%%p/gi, '±');
};

/**
 * A streamlined DXF parser.
 * Supports TABLES for layer names.
 * Supports ENTITIES: LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC, TEXT, MTEXT, DIMENSION, INSERT.
 */
export const parseDxf = (dxfContent: string): DxfData => {
  const lines = dxfContent.split(/\r\n|\r|\n/);
  const entities: DxfEntity[] = [];
  const layers = new Set<string>();

  let section = 'NONE'; // NONE | TABLES | ENTITIES
  let tableType = 'NONE'; // Inside TABLES: LAYER, etc.
  
  let currentEntity: Partial<DxfEntity> | null = null;
  // Track if we are inside a POLYLINE sequence
  let inPolyline = false;
  
  let i = 0;

  while (i < lines.length) {
    const codeStr = lines[i].trim();
    const value = lines[i + 1]?.trim();
    i += 2;

    if (!codeStr || !value) continue;
    const code = parseInt(codeStr, 10);
    if (isNaN(code)) continue;

    // Handle Section Start
    if (code === 0 && value === 'SECTION') {
      const nextCode = parseInt(lines[i]?.trim(), 10);
      const nextValue = lines[i + 1]?.trim();
      if (nextCode === 2) {
        section = nextValue;
        i += 2;
      }
      continue;
    }

    // Handle Section End
    if (code === 0 && value === 'ENDSEC') {
      section = 'NONE';
      tableType = 'NONE';
      continue;
    }

    // --- TABLES SECTION (Get all Layer names) ---
    if (section === 'TABLES') {
      if (code === 0 && value === 'TABLE') {
        continue;
      }
      
      if (code === 2 && value === 'LAYER') {
        tableType = 'LAYER';
      } else if (code === 0 && value === 'ENDTAB') {
        tableType = 'NONE';
      }

      if (tableType === 'LAYER') {
        if (code === 2) {
            layers.add(decodeDxfString(value));
        }
      }
    }

    // --- ENTITIES SECTION ---
    if (section === 'ENTITIES') {
      if (code === 0) {
        // New Entity Start
        const typeStr = value;
        
        // Finalize previous entity if it's not a POLYLINE being built
        if (currentEntity && !inPolyline) {
          finalizeEntity(currentEntity, entities, layers);
          currentEntity = null;
        }

        // Special handling for POLYLINE sequence
        if (typeStr === 'POLYLINE') {
           inPolyline = true;
           // Initialize the container, treating it like an LWPOLYLINE for rendering simplicity
           currentEntity = {
             type: EntityType.LWPOLYLINE,
             layer: '0',
             vertices: [],
             _originalType: 'POLYLINE'
           };
        } else if (typeStr === 'VERTEX') {
           if (inPolyline && currentEntity) {
             // We are inside a polyline, this is a vertex.
             // We don't create a new entity, we just prepare to parse properties into a temporary point
             // But simpler approach: just parse x/y/z codes right here? 
             // DXF structure: 0 VERTEX -> properties... -> 0 VERTEX
             // So when we hit 0 VERTEX, we are technically starting a new entity object in DXF terms.
             // BUT for our simplified parser, we treat VERTEX as just adding data to the parent POLYLINE.
             
             // Check if we have a pending point from previous VERTEX?
             // No, let's just use a flag or modify how parseProperty works.
             // Actually, standard parsing loop expects `currentEntity`. 
             // Let's keep `currentEntity` pointing to the POLYLINE.
             // And we will append a new vertex object to it.
           }
        } else if (typeStr === 'SEQEND') {
           if (inPolyline && currentEntity) {
             finalizeEntity(currentEntity, entities, layers);
             currentEntity = null;
             inPolyline = false;
           }
        } else {
           // Normal Entity
           if (inPolyline) {
             // If we hit a non-VERTEX/SEQEND while in polyline (shouldn't happen in valid DXF), abort polyline
             if (currentEntity) finalizeEntity(currentEntity, entities, layers);
             inPolyline = false;
           }
           
           currentEntity = {
             type: mapType(typeStr),
             layer: '0',
             vertices: [],
             _originalType: typeStr
           };
        }
      } else if (currentEntity) {
        // Parse Properties
        if (inPolyline && currentEntity._originalType === 'POLYLINE') {
            // We are parsing properties for POLYLINE or its VERTEX
            // This is tricky in a linear loop. 
            // Simplified: If code is 10/20, we assume it's a vertex coordinate
            // Note: POLYLINE entity itself has 10/20/30 (usually 0), VERTEX has actual points.
            // We will heuristically add points.
            parsePolylineProperty(code, value, currentEntity);
        } else {
            parseProperty(code, value, currentEntity);
        }
      }
    }
  }

  // Push last entity
  if (currentEntity) {
    finalizeEntity(currentEntity, entities, layers);
  }

  return {
    entities,
    layers: Array.from(layers).sort()
  };
};

const mapType = (typeStr: string): EntityType => {
  switch (typeStr) {
    case 'LINE': return EntityType.LINE;
    case 'LWPOLYLINE': return EntityType.LWPOLYLINE;
    case 'CIRCLE': return EntityType.CIRCLE;
    case 'ARC': return EntityType.ARC;
    case 'TEXT': return EntityType.TEXT;
    case 'MTEXT': return EntityType.TEXT;
    case 'DIMENSION': return EntityType.DIMENSION;
    case 'INSERT': return EntityType.INSERT;
    // POLYLINE handled manually
    default: return EntityType.UNKNOWN;
  }
};

const parsePolylineProperty = (code: number, value: string, entity: Partial<DxfEntity>) => {
    // Handling VERTEX coordinates for POLYLINE
    // We assume every 10 starts a new vertex or updates the last one
    const valNum = parseFloat(value);
    
    // We need to distinguish between POLYLINE header coords (which we ignore usually) and VERTEX coords.
    // However, in this simple parser, we just collect all 10/20 pairs as vertices.
    // This might catch the header 0,0, but that's usually fine or invisible.
    
    if (code === 8) { // Layer
        entity.layer = decodeDxfString(value);
    } else if (code === 70) { // Closed flag
         if ((parseInt(value) & 1) === 1) entity.closed = true;
    } else if (code === 10) {
        if (!entity.vertices) entity.vertices = [];
        entity.vertices.push({ x: valNum, y: 0 });
    } else if (code === 20) {
        if (entity.vertices && entity.vertices.length > 0) {
            entity.vertices[entity.vertices.length - 1].y = valNum;
        }
    }
};

const parseProperty = (code: number, value: string, entity: Partial<DxfEntity>) => {
  const valNum = parseFloat(value);
  
  switch (code) {
    case 8: // Layer Name
      entity.layer = decodeDxfString(value);
      break;
    
    // Coordinates
    case 10: // Start X / Center X / Insertion X
      if (!entity.start) entity.start = { x: 0, y: 0 };
      if (!entity.center) entity.center = { x: 0, y: 0 };
      
      if (entity.type === EntityType.LWPOLYLINE) {
        entity.vertices?.push({ x: valNum, y: 0 });
      } else {
        entity.start.x = valNum;
        entity.center.x = valNum; // reused for Circle/Arc center
      }
      break;
    case 20: // Start Y / Center Y / Insertion Y
      if (entity.type === EntityType.LWPOLYLINE) {
        const lastV = entity.vertices ? entity.vertices[entity.vertices.length - 1] : null;
        if (lastV) lastV.y = valNum;
      } else {
        if (entity.start) entity.start.y = valNum;
        if (entity.center) entity.center.y = valNum;
      }
      break;
      
    case 11: // End X
      if (!entity.end) entity.end = { x: 0, y: 0 };
      entity.end.x = valNum;
      break;
    case 21: // End Y
      if (!entity.end) entity.end = { x: 0, y: 0 };
      entity.end.y = valNum;
      break;

    case 40: // Radius or Text Height
      entity.radius = valNum;
      break;
    
    case 50: // Angle
      // MTEXT: Rotation in Radians
      // TEXT: Rotation in Degrees
      if (entity._originalType === 'MTEXT') {
          entity.startAngle = valNum * (180 / Math.PI);
      } else {
          entity.startAngle = valNum; 
      }
      break;
      
    case 51: // End Angle (Arc)
      entity.endAngle = valNum; 
      break;
      
    case 70: // Flags
       if (entity.type === EntityType.LWPOLYLINE) {
         if ((parseInt(value) & 1) === 1) entity.closed = true;
       }
       break;
    
    case 1: // Text content
      entity.text = decodeDxfString(value);
      break;
      
    case 2: // Block Name for INSERT
      if (entity.type === EntityType.INSERT) {
        entity.blockName = value;
      }
      break;
  }
};

const finalizeEntity = (raw: Partial<DxfEntity>, list: DxfEntity[], layers: Set<string>) => {
  if (raw.type === EntityType.UNKNOWN) return;
  if (raw.layer) layers.add(raw.layer);
  list.push(raw as DxfEntity);
};