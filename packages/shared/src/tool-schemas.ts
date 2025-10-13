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
    description: "Cria um compromisso no Google Calendar do usuário.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Título curto e claro para o evento."
        },
        start: {
          type: "string",
          format: "date-time",
          description: "Início em ISO 8601 (inclua timezone quando souber)."
        },
        end: {
          type: "string",
          format: "date-time",
          description: "Término em ISO 8601. Use duration_minutes se não souber."
        },
        duration_minutes: {
          type: "integer",
          minimum: 5,
          maximum: 720,
          description: "Duração em minutos quando `end` não for informado."
        },
        timezone: {
          type: "string",
          description: "Timezone IANA (ex.: America/Sao_Paulo)."
        },
        location: {
          type: "string",
          description: "Local do compromisso."
        },
        description: {
          type: "string",
          description: "Detalhes adicionais ou contexto."
        },
        attendees: {
          type: "array",
          description: "Lista de e-mails para convidar.",
          items: {
            type: "string",
            format: "email"
          }
        }
      },
      required: ["title", "start"]
    }
  }
] as const;
