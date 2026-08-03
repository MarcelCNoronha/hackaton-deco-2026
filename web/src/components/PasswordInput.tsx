import { useState } from "react";

/** A password `<input>` with a show/hide toggle — forwards every prop except `type`, which it
 *  controls itself. Drop-in replacement for `<input type="password" />`. */
export function PasswordInput(props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);

  return (
    <span className="password-input-wrap">
      <input {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="password-toggle-btn"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
      >
        {visible ? "🙈" : "👁"}
      </button>
    </span>
  );
}
