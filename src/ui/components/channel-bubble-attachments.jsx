import AttachmentView from "./attachment-view.jsx";
import { planBubbleAttachments } from "./bubble-attachment-plan.js";
import BubbleAttachmentCluster, { BubbleFileChips } from "./bubble-attachment-cluster.jsx";

// ТЗ редизайн канала A — вложения поста/комментария тем же языком, что пузырь чата.
export default function ChannelBubbleAttachments({ attachments, onOpen }) {
	const plan = planBubbleAttachments(attachments);
	if (!plan.visual.length && !plan.files.length && !plan.audios.length && !plan.voices.length) return null;
	return (
		<>
			<BubbleAttachmentCluster plan={plan} onOpen={onOpen} />
			<BubbleFileChips plan={plan} onOpen={onOpen} />
			{plan.voices.map((a, i) => (
				<AttachmentView key={`voice-${i}`} attachment={a} />
			))}
		</>
	);
}
