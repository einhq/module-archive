import { Group, Input, Select, TextInput } from '@mantine/core';
import { DATE_QUALIFIERS, type DateQualifier } from '@archive/people/date-qualifier';

const EXACT = 'exact';

const OPTIONS = [
  { value: EXACT, label: 'On' },
  ...DATE_QUALIFIERS.map((qualifier) => ({ value: qualifier, label: qualifier[0].toUpperCase() + qualifier.slice(1) })),
];

type QualifiedDateInputProps = {
  label: string;
  date: string;
  qualifier: DateQualifier | null;
  onChange: (date: string, qualifier: DateQualifier | null) => void;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
};

/** A date and how sure it is: on that date, or about, before or after it. */
export function QualifiedDateInput({ label, date, qualifier, onChange, placeholder = 'YYYY, YYYY-MM or YYYY-MM-DD', required, autoFocus }: QualifiedDateInputProps) {
  return (
    <Input.Wrapper label={label} required={required}>
      <Group gap='xs' wrap='nowrap'>
        <Select
          aria-label={`${label}: how sure`}
          data={OPTIONS}
          value={qualifier ?? EXACT}
          onChange={(value) => onChange(date, value && value !== EXACT ? value as DateQualifier : null)}
          allowDeselect={false}
          w={96}
        />
        <TextInput
          aria-label={label}
          style={{ flex: 1 }}
          value={date}
          onChange={(event) => onChange(event.currentTarget.value, qualifier)}
          placeholder={placeholder}
          required={required}
          data-autofocus={autoFocus || undefined}
        />
      </Group>
    </Input.Wrapper>
  );
}
