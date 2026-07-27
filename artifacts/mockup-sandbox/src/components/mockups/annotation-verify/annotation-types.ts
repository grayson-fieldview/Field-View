// Local mirror of shared/schema.ts AnnotationStroke for sandbox verification.
type Shape = {
  id: string;
  type: "pencil" | "arrow" | "rectangle" | "circle" | "line";
  color: string;
  width: number;
  points: { x: number; y: number }[];
};
type TextStroke = {
  id: string;
  type: "text";
  x: number;
  y: number;
  content: string;
  color: string;
  fontSize: number;
};
export type AnnotationStroke = Shape | TextStroke;
