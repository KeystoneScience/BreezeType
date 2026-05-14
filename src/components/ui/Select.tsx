import React from "react";
import SelectComponent from "react-select";
import CreatableSelect from "react-select/creatable";
import type {
  ActionMeta,
  Props as ReactSelectProps,
  SingleValue,
  StylesConfig,
} from "react-select";

export type SelectOption = {
  value: string;
  label: string;
  isDisabled?: boolean;
};

type BaseProps = {
  value: string | null;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  isClearable?: boolean;
  onChange: (value: string | null, action: ActionMeta<SelectOption>) => void;
  onBlur?: () => void;
  className?: string;
  formatCreateLabel?: (input: string) => string;
};

type CreatableProps = {
  isCreatable: true;
  onCreateOption: (value: string) => void;
};

type NonCreatableProps = {
  isCreatable?: false;
  onCreateOption?: never;
};

export type SelectProps = BaseProps & (CreatableProps | NonCreatableProps);

const selectStyles: StylesConfig<SelectOption, false> = {
  control: (base, state) => ({
    ...base,
    minHeight: 44,
    borderRadius: 16,
    borderColor: "var(--glass-hairline)",
    boxShadow: state.isFocused
      ? "0 0 0 1px rgba(59,130,246,0.45), 0 12px 28px -18px rgba(37,99,235,0.55)"
      : "0 6px 20px -14px rgb(0 0 0 / 0.28)",
    backgroundColor: "var(--glass-regular)",
    backdropFilter: "blur(24px)",
    fontSize: "15px",
    color: "var(--color-text)",
    cursor: state.isDisabled ? "not-allowed" : "pointer",
    transition: "all 150ms ease",
    ":hover": {
      borderColor: "var(--glass-hairline)",
      backgroundColor:
        "color-mix(in srgb, var(--glass-regular) 80%, white 20%)",
    },
  }),
  valueContainer: (base) => ({
    ...base,
    paddingInline: 12,
    paddingBlock: 4,
  }),
  input: (base) => ({
    ...base,
    color: "var(--color-text)",
  }),
  singleValue: (base) => ({
    ...base,
    color: "var(--color-text)",
  }),
  dropdownIndicator: (base, state) => ({
    ...base,
    color: "color-mix(in srgb, var(--color-muted) 80%, transparent)",
    cursor: state.selectProps.isDisabled ? "not-allowed" : "pointer",
    ":hover": {
      color: "var(--color-text)",
    },
  }),
  clearIndicator: (base, state) => ({
    ...base,
    color: "color-mix(in srgb, var(--color-muted) 80%, transparent)",
    cursor: state.selectProps.isDisabled ? "not-allowed" : "pointer",
    ":hover": {
      color: "var(--color-text)",
    },
  }),
  menu: (provided) => ({
    ...provided,
    zIndex: 40,
    backgroundColor: "var(--glass-regular)",
    color: "var(--color-text)",
    border: "1px solid var(--glass-hairline)",
    borderRadius: 14,
    backdropFilter: "blur(24px)",
    boxShadow: "var(--glass-shadow)",
  }),
  option: (base, state) => ({
    ...base,
    borderRadius: 10,
    backgroundColor: state.isSelected
      ? "rgba(59,130,246,0.12)"
      : state.isFocused
        ? "rgba(59,130,246,0.08)"
        : "transparent",
    color: state.isSelected ? "var(--color-accent)" : "var(--color-text)",
    cursor: state.isDisabled ? "not-allowed" : "pointer",
    opacity: state.isDisabled ? 0.5 : 1,
  }),
  placeholder: (base) => ({
    ...base,
    color: "color-mix(in srgb, var(--color-muted) 78%, transparent)",
  }),
};

export const Select: React.FC<SelectProps> = React.memo(
  ({
    value,
    options,
    placeholder,
    disabled,
    isLoading,
    isClearable = true,
    onChange,
    onBlur,
    className = "",
    isCreatable,
    formatCreateLabel,
    onCreateOption,
  }) => {
    const selectValue = React.useMemo(() => {
      if (!value) return null;
      const existing = options.find((option) => option.value === value);
      if (existing) return existing;
      return { value, label: value, isDisabled: false };
    }, [value, options]);

    const handleChange = (
      option: SingleValue<SelectOption>,
      action: ActionMeta<SelectOption>,
    ) => {
      onChange(option?.value ?? null, action);
    };

    const sharedProps: Partial<ReactSelectProps<SelectOption, false>> = {
      className,
      classNamePrefix: "app-select",
      value: selectValue,
      options,
      onChange: handleChange,
      placeholder,
      isDisabled: disabled,
      isLoading,
      onBlur,
      isClearable,
      styles: selectStyles,
    };

    if (isCreatable) {
      return (
        <CreatableSelect<SelectOption, false>
          {...sharedProps}
          onCreateOption={onCreateOption}
          formatCreateLabel={formatCreateLabel}
        />
      );
    }

    return <SelectComponent<SelectOption, false> {...sharedProps} />;
  },
);

Select.displayName = "Select";
