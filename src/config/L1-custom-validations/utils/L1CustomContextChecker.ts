// Function to validate UUID
export function isValidUUID(value: string): boolean {
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    return uuidRegex.test(value) && value.length <= 36;
}

// Function to validate message ID
export function isValidMessageID(value: string): boolean {
    return typeof value === 'string' && value.length <= 36;
}

