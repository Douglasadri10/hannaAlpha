export const toolSchemas = [
  {
    name: "switchLight",
    description: "Liga/desliga luz",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string" },
        state: { type: "string", enum: ["on", "off"] }
      },
      required: ["room", "state"]
    }
  },
  {
    name: "setAC",
    description: "Ajusta ar-condicionado",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string" },
        temp: { type: "number" }
      },
      required: ["room", "temp"]
    }
  },
  {
    name: "createCalendarEvent",
    description: "Cria evento no calendário",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        when: { type: "string" }
      },
      required: ["title", "when"]
    }
  }
] as const;
