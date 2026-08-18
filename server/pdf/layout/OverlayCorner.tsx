import { Text, View } from "@react-pdf/renderer";
import { styles } from "./styles";

/**
 * Procore-style photo overlay for PDFs: thin white right-aligned text in
 * the TOP-RIGHT corner of the photo, no background fill. @react-pdf has no
 * text-shadow, so legibility on light photos comes from a faux shadow — an
 * identical dark text layer offset by ~0.6pt rendered beneath the white one.
 * Line 1 = date/time, then the address split by splitOverlayAddress().
 */
export function OverlayCorner({ lines, large }: { lines: string[]; large?: boolean }) {
  if (lines.length === 0) return null;
  const textStyle = large ? styles.overlayCornerTextLarge : styles.overlayCornerText;
  const shadowStyle = large ? styles.overlayCornerShadowLarge : styles.overlayCornerShadow;
  return (
    <>
      <View style={styles.overlayCornerShadowBox}>
        {lines.map((line, i) => (
          <Text key={i} style={shadowStyle}>{line}</Text>
        ))}
      </View>
      <View style={styles.overlayCornerBox}>
        {lines.map((line, i) => (
          <Text key={i} style={textStyle}>{line}</Text>
        ))}
      </View>
    </>
  );
}
