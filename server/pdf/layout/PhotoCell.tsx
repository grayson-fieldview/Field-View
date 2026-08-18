import { Image, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import { styles } from "./styles";
import type { PhotoOverlayInfo } from "../types";

// maxLines/textOverflow are honored by @react-pdf/layout at runtime
// (read off node.style) but missing from the Style type in 3.4.5.
const clamp1 = { maxLines: 1, textOverflow: "ellipsis" } as unknown as Style;
const clamp3 = { maxLines: 3, textOverflow: "ellipsis" } as unknown as Style;

export function PhotoCell({
  buffer,
  caption,
  description,
  timestamp,
  overlay,
}: {
  buffer: Buffer | undefined;
  caption: string | null;
  description: string | null;
  timestamp?: string | null;
  /** Burned-in strip over the photo's bottom edge (null = off). */
  overlay?: PhotoOverlayInfo | null;
}) {
  const showOverlay = !!overlay && !!buffer && (overlay.timestamp || overlay.address);
  return (
    <View style={styles.cell} wrap={false}>
      <View style={styles.cellPhotoBox}>
        {buffer ? (
          <Image style={styles.cellPhoto} src={buffer} />
        ) : (
          <View style={styles.cellPhotoMissing} />
        )}
        {showOverlay ? (
          <View style={styles.photoOverlayStrip}>
            {overlay!.timestamp ? (
              <Text style={[styles.photoOverlayText, clamp1]}>{overlay!.timestamp}</Text>
            ) : null}
            {overlay!.address ? (
              <Text style={[styles.photoOverlayText, clamp1]}>{overlay!.address}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {caption ? <Text style={[styles.cellCaption, clamp1]}>{caption}</Text> : null}
      {description ? <Text style={[styles.cellDescription, clamp3]}>{description}</Text> : null}
      {timestamp ? <Text style={styles.cellTimestamp}>{timestamp}</Text> : null}
    </View>
  );
}
