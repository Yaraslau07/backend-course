# Assignment: Backend Course · Group A1

This file combines the course introduction and overall goal (from `0.0 Introduction.md`) with the full practical task of every lesson (1.0–2.4), copied verbatim. Lessons 0.1–0.6 contain theory only and have no practical task.

---

# Frontend Department / Backend Course / Group A1

## What is the course about?

This backend course helps frontend developers build skills that meet current market needs and develop a T-shaped profile: broad knowledge supported by deep expertise in a core area.

> All participants work on the same assignment, ***but any part of it may be adjusted individually in agreement with their mentor.***
>

## Tools

You may use any tools, including AI, at every implementation stage. You must be prepared to explain and justify every technical decision during interim and final reviews with your mentor. Agree with your mentor before choosing tools that differ from those recommended in the assignment.

## Mentors

Each participant is assigned a mentor based on their level of training and location.
The mentor checks progress on the practical assignment every week.

> ***You can contact your mentor for theoretical or technical advice at any stage of the course.*** Contact your mentor and schedule a calendar meeting to arrange a consultation.
If you share an office with your mentor, you can also ask them in person without scheduling a meeting.
> 

### Final result

By the end of the course, you will have built a backend service: a monolithic HTTP API with a relational database, access checks, and background tasks. All scenarios run through an HTTP client; a separate frontend is not required.

The service registers users, optionally verifies their email, logs them in using access and refresh cookies, manages roles and permissions, and authorizes protected operations. Users can view and update their profiles and delete their accounts. Administrators manage the user list, roles, and other users’ profiles. The same service transforms text files and images, provides operation history, and optionally saves results to object storage.

### Resources

#### Node.js

> Boilerplate for starting a new monolithic project on NestJS.
> Contains basic modules and connections.
> [https://github.com/pavel-skripko-innowise/nestjs-monolith-boilerplate](https://github.com/pavel-skripko-innowise/nestjs-monolith-boilerplate)

#### .NET

> Project template for starting a monolithic Web API on .NET Core.
> Contains a basic API endpoint `/health`, which verifies that the service is running.
> OpenAPI is enabled in the Development environment.
> Currently the template only provides an OpenAPI document; the Swagger UI is not included.
> The test project uses xUnit and verifies that a GET request to `/health` returns 200 OK.
> [https://github.com/pavel-skripko-innowise/dotnet-minimal-webapi-boilerplate/](https://github.com/pavel-skripko-innowise/dotnet-minimal-webapi-boilerplate/)
