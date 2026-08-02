import Screen from "../components/screen.jsx";
import HelpContent from "../components/help-content.jsx";
import { t } from "../signals/i18n.js";

export default function Help() {
	return (
		<Screen title={t("nav.help")}>
			<HelpContent />
		</Screen>
	);
}
