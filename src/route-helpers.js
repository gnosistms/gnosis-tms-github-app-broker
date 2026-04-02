export function parseInstallationId(value) {
  return Number.parseInt(value, 10);
}

export function asyncJsonRoute(handler, errorStatus = 400) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      response.status(errorStatus).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function asyncTextRoute(handler, errorStatus = 400) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      response.status(errorStatus).send(error instanceof Error ? error.message : String(error));
    }
  };
}
