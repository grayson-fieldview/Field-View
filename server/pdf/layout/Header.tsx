import { Text, View } from "@react-pdf/renderer";
import { styles } from "./styles";

export function Header({ title, dateText }: { title: string; dateText: string }) {
  return (
    <View style={styles.header} fixed>
      <Text style={styles.headerTitle}>{title}</Text>
      <Text style={styles.headerDate}>{dateText}</Text>
    </View>
  );
}
