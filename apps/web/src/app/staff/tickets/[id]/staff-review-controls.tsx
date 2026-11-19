"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function StaffReviewControls({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function decide(decision: "approve" | "reject") {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(`/staff/tickets/${ticketId}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        setMessage("Could not save the decision. Refresh the ticket and try again.");
        return;
      }
      const result: { outcome?: string } = await response.json();
      setMessage(
        result.outcome === "recorded"
          ? "Decision recorded."
          : "This review no longer accepts decisions.",
      );
      router.refresh();
    } catch {
      setMessage("Could not save the decision. Try again.");
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => void decide("approve")}>
          Approve
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void decide("reject")}
        >
          Reject
        </Button>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {message}
      </p>
    </>
  );
}
