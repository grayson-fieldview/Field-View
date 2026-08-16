import { Image, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import { styles } from "./styles";

// maxLines/textOverflow are honored by @react-pdf/layout at runtime
// (read off node.style) but missing from the Style type in 3.4.5.
const clamp1 = { maxLines: 1, textOverflow: "ellipsis" } as unknown as Style;
const clamp3 = { maxLines: 3, textOverflow: "ellipsis" } as unknown as Style;

export function PhotoCell({
  buffer,
  caption,
  description,
  timestamp,
}: {
  buffer: Buffer | undefined;
  caption: string | null;
  description: string | null;
  timestamp?: string | null;
}) {
  return (
    <View style={styles.cell} wrap={false}>
      <View style={styles.cellPhotoBox}>
        {buffer ? (
          <Image style={styles.cellPhoto} src={buffer} />
        ) : (
          <View style={styles.cellPhotoMissing} />
        )}
      </View>
      {caption ? <Text style={[styles.cellCaption, clamp1]}>{caption}</Text> : null}
      {description ? <Text style={[styles.cellDescription, clamp3]}>{description}</Text> : null}
      {timestamp ? <Text style={styles.cellTimestamp}>{timestamp}</Text> : null}
    </View>
  );
}
