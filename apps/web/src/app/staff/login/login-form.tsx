"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  STAFF_LOGIN_ERROR,
  STAFF_LOGIN_RATE_LIMITED,
  STAFF_LOGIN_UNAVAILABLE,
} from "@/lib/staff/messages";

const loginSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

type LoginInput = z.infer<typeof loginSchema>;

/** 401 and an unknown address share one sentence; the route never varies it. */
function messageFor(status: number): string {
  if (status === 429) return STAFF_LOGIN_RATE_LIMITED;
  if (status === 401) return STAFF_LOGIN_ERROR;
  return STAFF_LOGIN_UNAVAILABLE;
}

export function LoginForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string>();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setMessage(undefined);
    try {
      const response = await fetch("/staff/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (response.ok) {
        router.push("/staff/tickets");
        return;
      }
      setMessage(messageFor(response.status));
    } catch {
      setMessage(STAFF_LOGIN_UNAVAILABLE);
    }
  });

  const fieldError = errors.email?.message ?? errors.password?.message;

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="staff-email">Email</Label>
        <Input
          id="staff-email"
          type="email"
          autoComplete="username"
          aria-invalid={errors.email ? true : undefined}
          {...register("email")}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="staff-password">Password</Label>
        <Input
          id="staff-password"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? true : undefined}
          {...register("password")}
        />
      </div>
      {(message ?? fieldError) ? (
        <p role="alert" className="text-sm text-destructive">
          {message ?? fieldError}
        </p>
      ) : null}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-sm text-muted-foreground">
        Accounts are invite-only. Ask IT to enable your staff account.
      </p>
    </form>
  );
}
