# Rubric: Data Structures - Internal Test 1

Total: 10 marks

## Q1 (4 marks): Stack
- Correct definition as a linear structure following LIFO (Last In, First Out): 2 marks
  - Award 0 if described as FIFO.
- Names push (insert at top) and pop (remove from top): 2 marks (1 each)

## Q2 (6 marks): Binary search
- States that the array must be sorted: 2 marks
- Explains comparing with the middle element and halving the search space: 2 marks
- States time complexity O(log n): 2 marks
  - Award 0 for O(n) or for describing a one-by-one (linear) scan.

## Grading instructions
- Award marks only for what is written on the sheet.
- Give brief feedback per question explaining marks gained or lost.
- Return JSON only: {"score": number, "max_score": 10, "feedback": [{"question": "Q1", "marks": number, "max": number, "comment": string}]}
