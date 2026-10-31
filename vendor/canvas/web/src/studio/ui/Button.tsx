import { cva } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

export const buttonVariants = cva("stv-btn", {
    variants: { variant: { primary: "primary", ghost: "ghost", quiet: "quiet" } },
    defaultVariants: { variant: "ghost" },
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "quiet" };

export function Button({ variant, className, ...rest }: ButtonProps) {
    return <button type="button" className={[buttonVariants({ variant }), className].filter(Boolean).join(" ")} {...rest} />;
}
