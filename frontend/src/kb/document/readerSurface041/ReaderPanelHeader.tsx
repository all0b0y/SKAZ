import { useUi } from '../../state/context';
import { ReaderHeader, type ReaderHeaderProps } from './ReaderHeader';

type ReaderPanelHeaderProps = Omit<ReaderHeaderProps, 'expanded' | 'onBack' | 'onClose' | 'onToggleExpanded'>;

/** The production reader header uses the same navigator as citations and the panel resizer. */
export function ReaderPanelHeader(props: ReaderPanelHeaderProps) {
  const expanded = useUi((s) => s.docExpanded);
  const toggle = useUi((s) => s.toggleDocExpanded);
  const close = useUi((s) => s.closeDoc);
  const back = useUi((s) => s.docHistory.length > 0 ? s.goBack : undefined);

  return <ReaderHeader {...props} expanded={expanded} onBack={back} onClose={close} onToggleExpanded={toggle} />;
}
