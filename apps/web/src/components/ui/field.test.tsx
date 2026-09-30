import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "./field";

describe("shadcn Field", () => {
  it("renders the field parts with their slots", () => {
    const html = renderToStaticMarkup(
      <FieldSet>
        <FieldLegend variant="label">Contact</FieldLegend>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Title</FieldTitle>
              <FieldLabel htmlFor="x">Label</FieldLabel>
              <FieldDescription>Help</FieldDescription>
            </FieldContent>
          </Field>
          <FieldSeparator>or</FieldSeparator>
          <FieldSeparator />
        </FieldGroup>
      </FieldSet>,
    );
    for (const slot of [
      "field-set",
      "field-legend",
      "field-group",
      "field",
      "field-content",
      "field-label",
      "field-description",
      "field-separator",
      "field-separator-content",
    ]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
    expect(html).toContain('data-orientation="horizontal"');
    expect(html).toContain('for="x"');
  });

  it("renders errors from children, one message, or a list, and nothing when empty", () => {
    expect(renderToStaticMarkup(<FieldError>Bad</FieldError>)).toMatch(/role="alert"[^>]*>Bad</);
    expect(renderToStaticMarkup(<FieldError errors={[{ message: "One" }]} />)).toContain(">One<");
    const list = renderToStaticMarkup(
      <FieldError errors={[{ message: "A" }, { message: "B" }, { message: "A" }]} />,
    );
    expect(list).toContain("<li>A</li><li>B</li>");
    expect(renderToStaticMarkup(<FieldError errors={[]} />)).toBe("");
    expect(renderToStaticMarkup(<FieldError />)).toBe("");
  });
});

describe("shadcn Alert", () => {
  it("renders an alert with its parts", () => {
    const html = renderToStaticMarkup(
      <Alert variant="destructive">
        <AlertTitle>T</AlertTitle>
        <AlertDescription>D</AlertDescription>
        <AlertAction>A</AlertAction>
      </Alert>,
    );
    expect(html).toMatch(/^<div data-slot="alert" role="alert"/);
    for (const slot of ["alert-title", "alert-description", "alert-action"]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
  });
});
