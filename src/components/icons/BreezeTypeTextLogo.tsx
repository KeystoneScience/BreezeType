import React, { useMemo } from "react";
import breezeTypeLockupSvg from "../../assets/breezetype-lockup.svg?raw";

const LOCKUP_VIEWBOX_WIDTH = 6051;
const LOCKUP_VIEWBOX_HEIGHT = 884;

const BreezeTypeTextLogo = ({
  width = 184,
  height,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  const computedHeight =
    height ??
    Math.round((width / LOCKUP_VIEWBOX_WIDTH) * LOCKUP_VIEWBOX_HEIGHT);
  const svgMarkup = useMemo(
    () =>
      breezeTypeLockupSvg
        .replace("<svg ", '<svg aria-hidden="true" focusable="false" ')
        .replace('role="img"', 'aria-hidden="true" focusable="false"'),
    [breezeTypeLockupSvg],
  );

  return (
    <div
      className={`inline-flex shrink-0 items-center justify-start text-text ${className ?? ""}`}
      style={{ width, height: computedHeight }}
      role="img"
      aria-label="BreezeType"
    >
      <span
        aria-hidden="true"
        className="inline-flex h-full w-full shrink-0 items-center justify-center text-current"
        dangerouslySetInnerHTML={{ __html: svgMarkup }}
      />
    </div>
  );
};

export default BreezeTypeTextLogo;
