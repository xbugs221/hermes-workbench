/** Keep keystrokes local to the input, independently of transcript and navigation renders. */
export function createChatComposerInput(sdk: Record<string, any>) {
  const React = sdk.React;
  return function ChatComposerInput({ value, revision, onDraft, inputRef, ...props }: Record<string, any>) {
    const [draft, setDraft] = React.useState(value);
    React.useLayoutEffect(() => { setDraft(value); }, [value, revision]);
    return React.createElement('textarea', {
      ...props,
      ref: inputRef,
      value: draft,
      onChange: (event: { target: { value: string } }) => {
        const text = event.target.value;
        setDraft(text);
        onDraft(text);
      },
    });
  };
}
