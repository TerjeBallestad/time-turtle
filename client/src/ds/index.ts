// PM Board design system — see readme.md for look/voice, TOKENS.md for the CSS custom properties.
// Importing this module also loads the token stylesheets, so `import { Button } from '../ds'`
// is enough to get both the component and the variables it renders against.
import './styles.css';

export * from './types';

// core
export { Avatar, type AvatarProps, type AvatarTone } from './components/core/Avatar';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './components/core/Button';
export { Chip, type ChipProps, type ChipTone } from './components/core/Chip';
export { Kbd, type KbdProps } from './components/core/Kbd';
export { ProgressBar, type ProgressBarProps } from './components/core/ProgressBar';
export { SegToggle, type SegToggleProps } from './components/core/SegToggle';
export { StatusDot, type StatusDotProps, type StatusDotState } from './components/core/StatusDot';

// forms
export { FormRow, type FormRowProps } from './components/forms/FormRow';
export { Input, type InputProps } from './components/forms/Input';
export { SearchInput, type SearchInputProps } from './components/forms/SearchInput';
export { Select, type SelectProps } from './components/forms/Select';
export { Textarea, type TextareaProps } from './components/forms/Textarea';

// feedback
export { Modal, type ModalProps } from './components/feedback/Modal';
export { Toast, ToastStack, type ToastProps, type ToastStackProps } from './components/feedback/Toast';

// board
export { ListRow, type ListRowProps } from './components/board/ListRow';
export { NavRow, type NavRowProps } from './components/board/NavRow';
export { SectionLabel, type SectionLabelProps } from './components/board/SectionLabel';
export { TicketCard, type TicketCardProps, type TicketKind } from './components/board/TicketCard';
