# Output Types

```
export type validationOutput = {
	valid: boolean;
	code: number;
	description?: string;
}[];
```

# L1 Custom Validations

```
import { validationOutput } from "./types";

export function performL1CustomValidations(
	payload: any,
	action: string,
	allErrors = false,
	externalData = {}
): validationOutput {
	console.log("Performing custom L1 validations for action: " + action);
	return [
		{
			valid: true,
			code: 200,
			description: "Custom validation passed",
		},
	];
}
```

**How to Add Custom L1 Validations**

To implement domain-specific validations, modify the performL1CustomValidations function according to your needs while ensuring the following:

    1. Maintain the function signature
        • Keep the same parameters and return type.

    2. Return the output in the validationOutput format
        • Each validation result should be an object containing valid, code, and an optional description.

    3. Keep the same function name (performL1CustomValidations)
        • As it is already used in api service layer for L1 custom validations.

By following these guidelines, you can easily integrate and customize L1 validations for different use cases. 🚀


# Business Validations (L1_) for Order Processing

*(If these validations fail, they will result in NACK)*

## 1. /init and /confirm Validations

| Validation                     | API       | NACK Code | Reason for Failure                                       | Condition                                                                 | Who NACKs It? |
|--------------------------------|-----------|-----------|---------------------------------------------------------|--------------------------------------------------------------------------|--------------|
| Order Validation Failure       | /confirm  | 66002     | Order details are invalid or missing.                   | LSP is unable to validate the order request, validation includes - order object (items / quantity / quote / fulfillment) same as in /on_init; | LSP          |
| Order Not Found                | /confirm  | 66004     | Order does not exist or was cancelled                   | Order passed in subsequent API calls (/confirm, /status, /cancel, /update) | LSP          |
| Internal Server Error (LSP)     | /confirm  | 66001     | LSP faces system failure (e.g., HTTP 504)               | LSP cannot process the request due to temporary errors                   | LSP          |
| Service Time Agreement (S2D TAT) Violation | /confirm  | 60008 | Service time commitment differs from quoted /on_search | S2D TAT or pickup time is different from initial quote                   | LSP          |
| Feature not supported          | /init, /confirm, /update,/cancel | N/A | Feature is not supported by LSP                        | Feature used by LBNP is not supported by LSP                             | LSP          |
| Item not found                 | /init     | 66002      | Selected item does not exist in the catalog            | LSP is unable to initialize the order based on the selected item or its details | LSP          |
| Weight & Dimension Mismatch    | /confirm  | 60011     | Order weight/dimensions differ from /search data       | Weight/dimensions not matching original data (Mandatory for intercity orders) | LSP          |
| LSP Terms Not Accepted         | /confirm  | 62501     | LBNP does not accept LSP-provided terms                | LBNP must accept LSP terms before confirming                              | LSP          |

## 2. /on_confirm Validations

| Validation                     | API       | NACK Code | Reason for Failure                                       | Condition                                        | Who NACKs It? |
|--------------------------------|-----------|-----------|---------------------------------------------------------|-------------------------------------------------|--------------|
| Order Validation Failure       | /on_confirm | 63002  | Order details are invalid or missing                   | LBNP is unable to validate the order request   | LBNP         |

## 3. /cancel Validations

| Validation                     | API       | NACK Code | Reason for Failure                                       | Condition                                       | Who NACKs It? |
|--------------------------------|-----------|-----------|---------------------------------------------------------|------------------------------------------------|--------------|
| Invalid Cancellation Reason    | /cancel   | 60009     | The cancellation reason is not valid                    | LSP verifies cancellation reason against allowed codes | LSP          |

