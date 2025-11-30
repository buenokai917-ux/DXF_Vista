import { EntityType } from "../types";

/**
 * Generates a minimal valid DXF string with specific layers and entities
 * to test the Structure Analysis pipeline (View Splitting, Merge, Columns, Walls).
 */
export const generateMockDxfContent = (): string => {
  const lines: string[] = [];

  const push = (str: string) => lines.push(str);

  // Header
  push("0"); push("SECTION");
  push("2"); push("ENTITIES");

  // --- HELPER FUNCTIONS ---
  const addLine = (layer: string, x1: number, y1: number, x2: number, y2: number) => {
    push("0"); push("LINE");
    push("8"); push(layer);
    push("10"); push(x1.toString()); push("20"); push(y1.toString());
    push("11"); push(x2.toString()); push("21"); push(y2.toString());
  };

  const addRect = (layer: string, x: number, y: number, w: number, h: number) => {
     push("0"); push("LWPOLYLINE");
     push("8"); push(layer);
     push("90"); push("4"); // Vertices
     push("70"); push("1"); // Closed
     push("10"); push(x.toString()); push("20"); push(y.toString());
     push("10"); push((x+w).toString()); push("20"); push(y.toString());
     push("10"); push((x+w).toString()); push("20"); push((y+h).toString());
     push("10"); push(x.toString()); push("20"); push((y+h).toString());
  };

  const addText = (layer: string, text: string, x: number, y: number) => {
      push("0"); push("TEXT");
      push("8"); push(layer);
      push("10"); push(x.toString()); push("20"); push(y.toString());
      push("40"); push("300"); // Height
      push("1"); push(text);
  };

  // --- 1. AXIS Lines (Grid) ---
  // Creating a grid box (approx 20m x 20m)
  // Horizontal Axis
  addLine("AXIS", -2000, 0, 22000, 0);
  addLine("AXIS", -2000, 10000, 22000, 10000);
  
  // Vertical Axis
  addLine("AXIS", 0, -2000, 0, 12000);
  addLine("AXIS", 10000, -2000, 10000, 12000);
  addLine("AXIS", 20000, -2000, 20000, 12000);

  // --- 2. Viewport Title ---
  // Text that identifies the split region
  addText("TEXT", "PLAN-VIEW-1", 5000, -1500);

  // --- 3. Columns (Layer COLUMN) ---
  // 500x500 boxes at intersections
  addRect("COLUMN", -250, -250, 500, 500);   // At 0,0
  addRect("COLUMN", 9750, -250, 500, 500);   // At 10000,0
  addRect("COLUMN", 19750, -250, 500, 500);  // At 20000,0
  
  // --- 4. Walls (Layer WALL) ---
  // Two parallel lines representing a 200mm thick wall between columns
  // Wall 1: Between 0,0 and 10000,0
  addLine("WALL", 250, 100, 9750, 100);
  addLine("WALL", 250, -100, 9750, -100);
  
  // Wall 2: Between 10000,0 and 20000,0
  addLine("WALL", 10250, 100, 19750, 100);
  addLine("WALL", 10250, -100, 19750, -100);

  // Footer
  push("0"); push("ENDSEC");
  push("0"); push("EOF");

  return lines.join("\n");
};