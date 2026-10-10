import { useLayoutEffect, type ReactNode } from "react";
import { MotionConfig, MotionGlobalConfig } from "framer-motion";
import { useMotionLevel } from "../../lib/motion";

/**
 * The motion level, for everything framer-motion animates — the selection pills, the projects
 * panel's fold, the toasts, the switcher's drums.
 *
 * At `off` framer skips every animation outright (`skipAnimations`: values land where they are
 * going), and `MotionConfig` tells the components that ask (`useReducedMotionConfig`) to take their
 * still path too. Otherwise framer follows the system on its own. The CSS and the Web Animations API
 * read the same level off the root (`motionStore`).
 */
export function MotionLevel({ children }: { children: ReactNode }) {
  const off = useMotionLevel() === "off";
  useLayoutEffect(() => {
    MotionGlobalConfig.skipAnimations = off;
  }, [off]);
  return <MotionConfig reducedMotion={off ? "always" : "user"}>{children}</MotionConfig>;
}
