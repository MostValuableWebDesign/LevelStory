export type GenerationResponseAcceptance = {
  requestToken: number;
  activeRequestToken: number;
  jobId: string;
  acceptedJobId: string;
};

export function acceptsGenerationResponse(input: GenerationResponseAcceptance): boolean {
  return input.requestToken === input.activeRequestToken
    && (!input.acceptedJobId || input.jobId === input.acceptedJobId);
}

export function acceptsGenerationJobResult(
  generationJobId: string,
  acceptedJobId: string,
): boolean {
  return !generationJobId || !acceptedJobId || generationJobId === acceptedJobId;
}

export function preserveReviewEndDate<T extends { endDate: string }>(
  currentRequest: T,
  incomingRequest: T,
  reviewSetRequested: boolean,
  initialEndDate?: string,
): T {
  if (!reviewSetRequested
    || currentRequest.endDate === incomingRequest.endDate
    || (initialEndDate !== undefined && currentRequest.endDate === initialEndDate)) {
    return incomingRequest;
  }
  return {
    ...incomingRequest,
    endDate: currentRequest.endDate,
  };
}